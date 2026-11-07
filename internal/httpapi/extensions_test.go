package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/db/dbtest"
	"github.com/giulianoo0/ss/internal/extension"
)

const kiwiHead = "0123456789abcdef0123456789abcdef01234567"

const openRepo = `{"private":false,"license":{"spdx_id":"MIT"}}`

// fakeExtensionRepos is GitHub with repositories at kiwiHead: ana/kiwi and
// bia/kiwi both claim the id kiwi; ana/torto has a manifest that does not
// validate; ana/fechado is private and ana/semlicenca has no license.
func fakeExtensionRepos(t *testing.T) *extension.GitHub {
	t.Helper()
	plain := `{"id":"%s","name":"X","version":"1","protocol":1,"entry":"index.html","hosts":{}}`
	repos := map[string][2]string{
		"ana/kiwi": {openRepo, `{"id":"kiwi","name":"Kiwi","version":"1","protocol":1,"entry":"index.html",
			"hosts":{"connect":["api.kiwi.com"],"images":["img.kiwi.com"],"media":["*.kiwicdn.com"]}}`},
		"bia/kiwi":       {openRepo, `{"id":"kiwi","name":"Outro Kiwi","version":"1","protocol":1,"entry":"index.html","hosts":{}}`},
		"ana/torto":      {openRepo, `{"id":"torto","name":"Torto","version":"1","protocol":1,"entry":"../index.html","hosts":{}}`},
		"ana/fechado":    {`{"private":true,"license":{"spdx_id":"MIT"}}`, fmt.Sprintf(plain, "fechado")},
		"ana/semlicenca": {`{"private":false,"license":null}`, fmt.Sprintf(plain, "semlicenca")},
	}
	mux := http.NewServeMux()
	for repo, files := range repos {
		mux.HandleFunc("GET /api/repos/"+repo, func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(files[0]))
		})
		mux.HandleFunc("GET /api/repos/"+repo+"/commits/HEAD", func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(kiwiHead))
		})
		mux.HandleFunc("GET /raw/"+repo+"/"+kiwiHead+"/juntos.json", func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(files[1]))
		})
	}
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return &extension.GitHub{APIBase: server.URL + "/api", RawBase: server.URL + "/raw", Client: server.Client()}
}

// extensionRig has three accounts signed in: ana and bia may publish,
// carol may not.
type extensionRig struct {
	server          http.Handler
	registry        *extension.Registry
	ana, bia, carol *http.Cookie
	anaID           int64
}

func newExtensionRig(t *testing.T) extensionRig {
	t.Helper()
	_, rdb := newRedis(t)
	pool := dbtest.New(t)
	registry := extension.NewRegistry(pool)
	accounts := account.NewStore(pool)
	signIn := func(discordID, name string) (int64, *http.Cookie) {
		created, err := accounts.SignInDiscord(t.Context(), account.DiscordUser{ID: discordID, GlobalName: name})
		require.NoError(t, err)
		token, err := accounts.StartSession(t.Context(), created.ID)
		require.NoError(t, err)
		return created.ID, &http.Cookie{Name: accountCookie, Value: token}
	}
	anaID, ana := signIn("1", "Ana")
	biaID, bia := signIn("2", "Bia")
	_, carol := signIn("3", "Carol")
	cfg := testCfg(t)
	cfg.ExtensionPublishers = []int64{anaID, biaID}
	access := ExtensionAccess{Registry: registry, GitHub: fakeExtensionRepos(t), Accounts: accounts, Quota: NewQuota(rdb, 0, 0, 0)}
	return extensionRig{
		server: NewServer(cfg, newTestStore(t), nil, WithExtensions(access)), registry: registry,
		ana: ana, bia: bia, carol: carol, anaID: anaID,
	}
}

func (rig extensionRig) do(method, path, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}
	rig.server.ServeHTTP(w, req)
	return w
}

func TestRegisteringAnExtensionFromGitHub(t *testing.T) {
	rig := newExtensionRig(t)

	w := rig.do(http.MethodPost, "/api/extensions", `{"repo":"ana/kiwi"}`, rig.ana)
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	var body struct {
		ID       string             `json:"id"`
		Sub      string             `json:"sub"`
		SHA      string             `json:"sha"`
		Manifest extension.Manifest `json:"manifest"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "kiwi", body.ID)
	require.Equal(t, extension.SubFor("kiwi"), body.Sub)
	require.Equal(t, kiwiHead, body.SHA)
	require.Equal(t, []string{"*.kiwicdn.com"}, body.Manifest.Hosts.Media)

	entry, err := rig.registry.ByID(t.Context(), "kiwi")
	require.NoError(t, err)
	require.Equal(t, "github:ana/kiwi", entry.Source)
	require.Equal(t, "Kiwi", entry.Name)
	require.Equal(t, rig.anaID, entry.CreatedBy)

	again := rig.do(http.MethodPost, "/api/extensions", `{"repo":"Ana/Kiwi"}`, rig.ana)
	require.Equal(t, http.StatusOK, again.Code, "o mesmo repositório de novo é idempotente")
	require.Contains(t, again.Body.String(), `"sub":"`+extension.SubFor("kiwi")+`"`)
}

func TestAnIDBelongsToWhoeverRegisteredItFirst(t *testing.T) {
	rig := newExtensionRig(t)
	require.Equal(t, http.StatusCreated, rig.do(http.MethodPost, "/api/extensions", `{"repo":"ana/kiwi"}`, rig.ana).Code)

	w := rig.do(http.MethodPost, "/api/extensions", `{"repo":"bia/kiwi"}`, rig.bia)
	require.Equal(t, http.StatusConflict, w.Code)
	require.JSONEq(t, `{"error":"id_taken"}`, w.Body.String())
	entry, err := rig.registry.ByID(t.Context(), "kiwi")
	require.NoError(t, err)
	require.Equal(t, "github:ana/kiwi", entry.Source)
}

func TestRegisteringRefusesWhatIsNotAnExtension(t *testing.T) {
	rig := newExtensionRig(t)

	w := rig.do(http.MethodPost, "/api/extensions", `{"repo":"ana/torto"}`, rig.ana)
	require.Equal(t, http.StatusUnprocessableEntity, w.Code)
	var body map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "bad_manifest", body["error"])
	require.Contains(t, body["detail"], "entry")

	require.Equal(t, http.StatusBadRequest, rig.do(http.MethodPost, "/api/extensions", `{"repo":"https://github.com/ana/kiwi"}`, rig.ana).Code)
	require.Equal(t, http.StatusNotFound, rig.do(http.MethodPost, "/api/extensions", `{"repo":"ana/nada"}`, rig.ana).Code)
	_, err := rig.registry.ByID(t.Context(), "torto")
	require.ErrorIs(t, err, extension.ErrNotFound)
}

func TestOnlyOpenSourceReposAreRegistered(t *testing.T) {
	rig := newExtensionRig(t)

	for _, repo := range []string{"ana/fechado", "ana/semlicenca"} {
		w := rig.do(http.MethodPost, "/api/extensions", `{"repo":"`+repo+`"}`, rig.ana)
		require.Equal(t, http.StatusUnprocessableEntity, w.Code, repo)
		require.JSONEq(t, `{"error":"not_open_source"}`, w.Body.String(), repo)
	}
	for _, id := range []string{"fechado", "semlicenca"} {
		_, err := rig.registry.ByID(t.Context(), id)
		require.ErrorIs(t, err, extension.ErrNotFound, id)
	}
}

// Using an extension needs no account; taking an id needs one of the
// publishing accounts.
func TestRegisteringNeedsAnAccount(t *testing.T) {
	rig := newExtensionRig(t)

	for _, cookies := range [][]*http.Cookie{
		nil,
		{{Name: sessionCookie, Value: "anonima"}},
		{{Name: accountCookie, Value: strings.Repeat("0", 64)}},
	} {
		w := rig.do(http.MethodPost, "/api/extensions", `{"repo":"ana/kiwi"}`, cookies...)
		require.Equal(t, http.StatusUnauthorized, w.Code)
		require.JSONEq(t, `{"error":"account_required"}`, w.Body.String())
	}
	_, err := rig.registry.ByID(t.Context(), "kiwi")
	require.ErrorIs(t, err, extension.ErrNotFound)
}

func TestOnlyPublishersRegister(t *testing.T) {
	rig := newExtensionRig(t)

	w := rig.do(http.MethodPost, "/api/extensions", `{"repo":"ana/kiwi"}`, rig.carol)
	require.Equal(t, http.StatusForbidden, w.Code)
	require.JSONEq(t, `{"error":"publisher_only"}`, w.Body.String())
	_, err := rig.registry.ByID(t.Context(), "kiwi")
	require.ErrorIs(t, err, extension.ErrNotFound)
}

func TestRegisteringIsCappedPerAccount(t *testing.T) {
	rig := newExtensionRig(t)
	for i := 0; i < extensionRegisterPerHour; i++ {
		require.Equal(t, http.StatusNotFound, rig.do(http.MethodPost, "/api/extensions", `{"repo":"ana/nada"}`, rig.ana).Code)
	}

	w := rig.do(http.MethodPost, "/api/extensions", `{"repo":"ana/kiwi"}`, rig.ana)
	require.Equal(t, http.StatusTooManyRequests, w.Code)
	require.Equal(t, http.StatusCreated, rig.do(http.MethodPost, "/api/extensions", `{"repo":"ana/kiwi"}`, rig.bia).Code,
		"a cota é de cada conta")
}

func TestAnExtensionIsLookedUpByID(t *testing.T) {
	rig := newExtensionRig(t)
	require.Equal(t, http.StatusNotFound, rig.do(http.MethodGet, "/api/extensions/kiwi", "").Code)
	require.Equal(t, http.StatusCreated, rig.do(http.MethodPost, "/api/extensions", `{"repo":"ana/kiwi"}`, rig.ana).Code)

	w := rig.do(http.MethodGet, "/api/extensions/kiwi", "")
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"id":"kiwi","name":"Kiwi","sub":"`+extension.SubFor("kiwi")+`","source":"github:ana/kiwi"}`, w.Body.String())

	require.Equal(t, http.StatusNotFound, rig.do(http.MethodGet, "/api/extensions/KIWI", "").Code)
}

func TestTheHostLooksAnExtensionUpBySub(t *testing.T) {
	rig := newExtensionRig(t)
	require.Equal(t, http.StatusCreated, rig.do(http.MethodPost, "/api/extensions", `{"repo":"ana/kiwi"}`, rig.ana).Code)
	sub := extension.SubFor("kiwi")

	w := rig.do(http.MethodGet, "/api/extensions/host/"+sub, "")
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"id":"kiwi","source":"github:ana/kiwi"}`, w.Body.String())
	require.Equal(t, "public, max-age=60", w.Header().Get("Cache-Control"))

	require.Equal(t, http.StatusNotFound, rig.do(http.MethodGet, "/api/extensions/host/aaaaaaaaaaaaaaaa", "").Code)
	require.Equal(t, http.StatusNotFound, rig.do(http.MethodGet, "/api/extensions/host/"+strings.ToUpper(sub), "").Code)
	require.Equal(t, http.StatusNotFound, rig.do(http.MethodGet, "/api/extensions/host/kiwi", "").Code)
}

func TestLatestIsTheHeadOfTheRepository(t *testing.T) {
	rig := newExtensionRig(t)
	require.Equal(t, http.StatusCreated, rig.do(http.MethodPost, "/api/extensions", `{"repo":"ana/kiwi"}`, rig.ana).Code)

	w := rig.do(http.MethodGet, "/api/extensions/kiwi/latest", "")
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"sha":"`+kiwiHead+`"}`, w.Body.String())

	require.Equal(t, http.StatusNotFound, rig.do(http.MethodGet, "/api/extensions/nada/latest", "").Code)
}
