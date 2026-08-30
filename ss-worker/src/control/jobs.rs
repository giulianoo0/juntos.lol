use std::sync::Arc;

use serde_json::json;

use super::envelope::Job;
use crate::engine::Engine;
use crate::http::AppState;

/// Runs one verified job and produces its result message.
pub async fn run(job: Job, engine: &Arc<Engine>, app: &Arc<AppState>, drain: &tokio::sync::Notify) -> serde_json::Value {
    let ok = |extra: serde_json::Value| {
        let mut v = json!({ "type": "result", "jobId": job.job_id, "kind": job.kind, "ok": true });
        if let Some(map) = extra.as_object() {
            for (k, val) in map {
                v[k] = val.clone();
            }
        }
        v
    };
    let err = |code: &str, detail: String| json!({ "type": "result", "jobId": job.job_id, "kind": job.kind, "ok": false, "error": code, "detail": detail });
    match job.kind.as_str() {
        "lease" => {
            let (Some(ih), Some(lease)) = (job.infohash.as_deref(), job.lease_id.as_deref()) else {
                return err("bad_job", "lease needs infohash and leaseId".into());
            };
            match engine.lease(ih, lease, &job.trackers).await {
                Ok(info) => ok(json!({ "infohash": info.infohash, "name": info.name, "files": info.files })),
                Err(e) => err(e.code(), e.to_string()),
            }
        }
        "select" => {
            let (Some(ih), Some(index)) = (job.infohash.as_deref(), job.file_index) else {
                return err("bad_job", "select needs infohash and fileIndex".into());
            };
            match engine.select(ih, index).await {
                Ok(bytes) => ok(json!({ "selectedBytes": bytes })),
                Err(e) => err(e.code(), e.to_string()),
            }
        }
        "renew" => {
            let (Some(ih), Some(lease)) = (job.infohash.as_deref(), job.lease_id.as_deref()) else {
                return err("bad_job", "renew needs infohash and leaseId".into());
            };
            if engine.renew_lease(ih, lease) {
                ok(json!({}))
            } else {
                err("unknown_lease", "no such lease".into())
            }
        }
        "release" => {
            let (Some(ih), Some(lease)) = (job.infohash.as_deref(), job.lease_id.as_deref()) else {
                return err("bad_job", "release needs infohash and leaseId".into());
            };
            engine.release(ih, lease).await;
            ok(json!({}))
        }
        "revoke" => {
            let Some(jti) = job.jti.as_deref() else { return err("bad_job", "revoke needs jti".into()) };
            app.revoke(jti, job.exp);
            ok(json!({}))
        }
        "drain" => {
            engine.drain();
            drain.notify_one();
            ok(json!({}))
        }
        "remuxStart" => {
            let (Some(ih), Some(index)) = (job.infohash.as_deref(), job.file_index) else {
                return err("bad_job", "remuxStart needs infohash and fileIndex".into());
            };
            let Some(raw) = job.remux.clone() else { return err("bad_job", "remuxStart needs a remux spec".into()) };
            let spec: crate::remux::protocol::Spec = match serde_json::from_value(raw) {
                Ok(s) => s,
                Err(e) => return err("bad_job", format!("remux spec: {e}")),
            };
            let supervisor = app.remux.read().clone();
            let Some(supervisor) = supervisor else { return err("remux_disabled", "no remux capability".into()) };
            match supervisor.start(ih, index, spec).await {
                Ok(()) => ok(json!({})),
                Err(e) => err(&e.to_string(), String::new()),
            }
        }
        "remuxCancel" => {
            let run_id = job
                .remux
                .as_ref()
                .and_then(|r| r.get("runId"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let Some(run_id) = run_id else { return err("bad_job", "remuxCancel needs runId".into()) };
            let supervisor = app.remux.read().clone();
            let Some(supervisor) = supervisor else { return err("remux_disabled", "no remux capability".into()) };
            if supervisor.cancel(&run_id).await {
                ok(json!({}))
            } else {
                err("unknown_run", "no such run".into())
            }
        }
        "setLimits" => {
            // Session-wide caps are what librqbit exposes at runtime; the
            // per-torrent upload cap is fixed at add time.
            err("unsupported", "runtime limits are not adjustable yet".into())
        }
        other => err("bad_job", format!("unknown kind {other}")),
    }
}
