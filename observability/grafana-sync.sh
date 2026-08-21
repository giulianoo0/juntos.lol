#!/usr/bin/env bash
#
# Pushes the dashboards and alert rules in this directory to a Grafana Cloud
# stack, and checks that metrics are actually arriving.
#
# The repository is the source of truth. Anything edited in the Grafana UI is
# overwritten the next time this runs, which is the point: a dashboard that
# only exists in someone's browser is one browser away from not existing.
#
# Two different credentials are involved, and they are not interchangeable:
#
#   GRAFANA_SA_TOKEN   a stack service account token (glsa_...), Editor role.
#                      Creates the folder, the dashboards and the alert rules.
#                      Cloud Access Policy tokens do NOT work on this API.
#
#   GRAFANA_CLOUD_PROM_*  the Cloud Access Policy token and the numeric
#                      instance id. Only used by the verify step, and only if
#                      the policy carries the metrics:read scope.
#
# Nothing here is written to disk and no credential belongs in this file or
# anywhere else in the repository. Export them, or keep them in a .env that
# .gitignore already excludes and source it:
#
#   set -a; . ./.env; set +a
#   ./observability/grafana-sync.sh
#
# Usage: grafana-sync.sh [all|dashboards|alerts|verify]

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
folder_title="${GRAFANA_FOLDER:-ss}"
command="${1:-all}"

die() { printf 'grafana-sync: %s\n' "$1" >&2; exit 1; }
note() { printf '  %s\n' "$1"; }

need() {
	for name in "$@"; do
		[ -n "${!name:-}" ] || die "$name is not set"
	done
}

for binary in curl jq; do
	command -v "$binary" >/dev/null || die "$binary is required"
done

# grafana calls the stack API and fails loudly on anything but a 2xx. The body
# is printed on failure because Grafana's errors say exactly what is wrong and
# swallowing them turns a five-second fix into an afternoon.
grafana() {
	local method="$1" path="$2"
	shift 2
	local body status
	body="$(curl -sS -o /tmp/grafana-sync.$$ -w '%{http_code}' \
		-X "$method" "${GRAFANA_URL%/}$path" \
		-H "Authorization: Bearer $GRAFANA_SA_TOKEN" \
		-H "Content-Type: application/json" \
		-H "Accept: application/json" \
		"$@")" || { rm -f /tmp/grafana-sync.$$; die "$method $path: request failed"; }
	status="$body"
	body="$(cat /tmp/grafana-sync.$$)"
	rm -f /tmp/grafana-sync.$$
	if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
		printf '%s\n' "$body" >&2
		die "$method $path returned $status"
	fi
	printf '%s' "$body"
}

# grafana_status is the same call for the one case where a 404 is an answer
# rather than a failure: asking whether something exists yet.
grafana_status() {
	local method="$1" path="$2"
	curl -sS -o /dev/null -w '%{http_code}' \
		-X "$method" "${GRAFANA_URL%/}$path" \
		-H "Authorization: Bearer $GRAFANA_SA_TOKEN" \
		-H "Accept: application/json"
}

check_token() {
	need GRAFANA_URL GRAFANA_SA_TOKEN
	case "$GRAFANA_SA_TOKEN" in
	glsa_*) ;;
	*) note "warning: the token does not look like a service account token (glsa_...)." ;;
	esac
	grafana GET /api/access-control/user/permissions >/dev/null
	note "token accepted by ${GRAFANA_URL%/}"
}

# ensure_folder prints the folder's uid, creating the folder the first time.
ensure_folder() {
	local existing
	existing="$(grafana GET /api/folders | jq -r --arg title "$folder_title" \
		'map(select(.title == $title)) | .[0].uid // empty')"
	if [ -n "$existing" ]; then
		printf '%s' "$existing"
		return
	fi
	grafana POST /api/folders --data "$(jq -nc --arg title "$folder_title" '{title: $title}')" \
		| jq -r '.uid'
}

push_dashboards() {
	check_token
	local folder_uid dashboard payload url
	folder_uid="$(ensure_folder)"
	note "folder $folder_title ($folder_uid)"
	for dashboard in "$here"/dashboards/*.json; do
		# version and id are dropped so the stack's own history decides them:
		# sending a stale version is how a push fails with a version conflict
		# on a dashboard nobody has touched.
		payload="$(jq -c --arg folder "$folder_uid" \
			'{dashboard: (. + {id: null, version: null}), folderUid: $folder,
			  overwrite: true, message: "pushed from the repository"}' "$dashboard")"
		url="$(grafana POST /api/dashboards/db --data "$payload" | jq -r '.url')"
		note "dashboard $(basename "$dashboard") -> ${GRAFANA_URL%/}$url"
	done
}

# datasource_uid finds the stack's Prometheus data source. Grafana Cloud
# provisions exactly one per stack, so picking the first is right; an override
# exists for the stack that has more than one.
datasource_uid() {
	if [ -n "${GRAFANA_DATASOURCE_UID:-}" ]; then
		printf '%s' "$GRAFANA_DATASOURCE_UID"
		return
	fi
	local found
	found="$(grafana GET /api/datasources \
		| jq -r 'map(select(.type == "prometheus")) | .[0].uid // empty')"
	[ -n "$found" ] || die "no Prometheus data source on the stack; set GRAFANA_DATASOURCE_UID"
	printf '%s' "$found"
}

push_alerts() {
	check_token
	local folder_uid ds_uid count index payload uid title status
	folder_uid="$(ensure_folder)"
	ds_uid="$(datasource_uid)"
	note "data source $ds_uid"
	count="$(jq 'length' "$here/alerts/ss-alerts.json")"
	for ((index = 0; index < count; index++)); do
		payload="$(jq -c --argjson i "$index" --arg folder "$folder_uid" --arg ds "$ds_uid" \
			'.[$i]
			 | .folderUID = $folder
			 | (.data[] | select(.datasourceUid == "${DATASOURCE_UID}")).datasourceUid = $ds
			 | (.data[].model | select(.datasource.uid? == "${DATASOURCE_UID}")).datasource.uid = $ds' \
			"$here/alerts/ss-alerts.json")"
		uid="$(printf '%s' "$payload" | jq -r '.uid')"
		title="$(printf '%s' "$payload" | jq -r '.title')"
		status="$(grafana_status GET "/api/v1/provisioning/alert-rules/$uid")"
		# X-Disable-Provenance is what keeps these rules editable in the UI.
		# It has to be on every write to a rule group or none of them: Grafana
		# refuses to mix provisioned and unprovisioned rules in one group, and
		# a rule that lands without it can only be changed by another push.
		if [ "$status" = "200" ]; then
			grafana PUT "/api/v1/provisioning/alert-rules/$uid" \
				-H "X-Disable-Provenance: true" --data "$payload" >/dev/null
			note "alert rule updated: $title"
		else
			grafana POST /api/v1/provisioning/alert-rules \
				-H "X-Disable-Provenance: true" --data "$payload" >/dev/null
			note "alert rule created: $title"
		fi
	done
	note "rules have no contact point of their own; they use the stack's default notification policy"
}

# verify asks Grafana Cloud whether the series actually arrived, which is the
# only question the dashboards cannot answer for themselves: an empty panel
# looks the same whether nothing is happening or nothing is being shipped.
verify() {
	need GRAFANA_CLOUD_PROM_URL GRAFANA_CLOUD_PROM_USER GRAFANA_CLOUD_PROM_TOKEN
	# The query endpoint is the remote_write URL without its /push suffix.
	local base result
	base="${GRAFANA_CLOUD_PROM_URL%/push}"
	for query in 'up{job="ss"}' 'ss_rooms_active' 'sum(ss_objectstore_operations_total)'; do
		result="$(curl -sS -u "$GRAFANA_CLOUD_PROM_USER:$GRAFANA_CLOUD_PROM_TOKEN" \
			--data-urlencode "query=$query" "$base/api/v1/query")"
		if [ "$(printf '%s' "$result" | jq -r '.status')" != "success" ]; then
			printf '%s\n' "$result" >&2
			die "instant query failed: $query"
		fi
		note "$query -> $(printf '%s' "$result" | jq -c '.data.result')"
	done
}

case "$command" in
dashboards) push_dashboards ;;
alerts) push_alerts ;;
verify) verify ;;
all)
	push_dashboards
	push_alerts
	verify
	;;
*) die "unknown command $command; use all, dashboards, alerts or verify" ;;
esac
