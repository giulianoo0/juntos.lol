package extension

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const kiwiSHA = "0123456789abcdef0123456789abcdef01234567"

const kiwiManifest = `{"id":"kiwi","name":"Kiwi","version":"1","protocol":1,"entry":"index.html",
	"hosts":{"connect":["api.kiwi.com"],"images":[],"media":["*.kiwicdn.com"]}}`

// fakeGitHub answers for ana/kiwi at kiwiSHA with body as its juntos.json.
func fakeGitHub(t *testing.T, body string) *GitHub {
	gh, _ := countingGitHub(t, body)
	return gh
}

// countingGitHub is fakeGitHub that also counts the HEAD calls and keeps the
// Authorization each one carried.
func countingGitHub(t *testing.T, body string) (*GitHub, *[]string) {
	t.Helper()
	var auth []string
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/repos/ana/kiwi/commits/HEAD", func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "application/vnd.github.sha", r.Header.Get("Accept"))
		auth = append(auth, r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(kiwiSHA))
	})
	mux.HandleFunc("GET /raw/ana/kiwi/"+kiwiSHA+"/juntos.json", func(w http.ResponseWriter, r *http.Request) {
		require.Empty(t, r.Header.Get("Authorization"), "o token só vai para a API")
		_, _ = w.Write([]byte(body))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return &GitHub{APIBase: server.URL + "/api", RawBase: server.URL + "/raw", Client: server.Client()}, &auth
}

func TestGitHubReusesTheHeadForAWhile(t *testing.T) {
	gh, calls := countingGitHub(t, kiwiManifest)
	now := time.Unix(1_800_000_000, 0)
	gh.Now = func() time.Time { return now }

	for range 5 {
		sha, err := gh.Head(t.Context(), "ana/kiwi")
		require.NoError(t, err)
		require.Equal(t, kiwiSHA, sha)
	}
	require.Len(t, *calls, 1, "60 chamadas por hora sem token: o HEAD não pode ir ao GitHub a cada abertura")

	now = now.Add(headTTL)
	_, err := gh.Head(t.Context(), "ana/kiwi")
	require.NoError(t, err)
	require.Len(t, *calls, 2)
}

func TestGitHubSendsTheTokenOnlyToTheAPI(t *testing.T) {
	gh, calls := countingGitHub(t, kiwiManifest)
	gh.Token = "ghp_e2e"

	sha, err := gh.Head(t.Context(), "ana/kiwi")
	require.NoError(t, err)
	require.Equal(t, []string{"Bearer ghp_e2e"}, *calls)
	_, err = gh.Manifest(t.Context(), "ana/kiwi", sha)
	require.NoError(t, err)
}

func TestGitHubReadsTheManifestAtHead(t *testing.T) {
	gh := fakeGitHub(t, kiwiManifest)

	sha, err := gh.Head(t.Context(), "ana/kiwi")
	require.NoError(t, err)
	require.Equal(t, kiwiSHA, sha)
	m, err := gh.Manifest(t.Context(), "ana/kiwi", sha)
	require.NoError(t, err)
	require.Equal(t, "kiwi", m.ID)
}

func TestGitHubUnknownRepoIsNotFound(t *testing.T) {
	gh := fakeGitHub(t, kiwiManifest)

	_, err := gh.Head(t.Context(), "ana/nada")
	require.ErrorIs(t, err, ErrRepoNotFound)
}

func TestGitHubMissingManifestIsABadManifest(t *testing.T) {
	gh := fakeGitHub(t, kiwiManifest)

	_, err := gh.Manifest(t.Context(), "ana/kiwi", strings.Repeat("f", 40))
	require.ErrorIs(t, err, ErrBadManifest)
}

func TestGitHubRefusesAManifestOver64KB(t *testing.T) {
	padded := strings.Replace(kiwiManifest, `"name":"Kiwi"`, `"name":"Kiwi","pad":"`+strings.Repeat("x", 64<<10)+`"`, 1)
	gh := fakeGitHub(t, padded)

	_, err := gh.Manifest(t.Context(), "ana/kiwi", kiwiSHA)
	require.ErrorIs(t, err, ErrBadManifest)
}

func TestParseRepo(t *testing.T) {
	for _, good := range []string{"ana/kiwi", "Ana-B/kiwi.js", "a/b_c"} {
		_, err := ParseRepo(good)
		require.NoError(t, err, good)
	}
	repo, _ := ParseRepo("Ana/Kiwi")
	require.Equal(t, "ana/kiwi", repo, "o GitHub não diferencia caixa; a fonte também não")
	for _, bad := range []string{"", "ana", "ana/", "/kiwi", "ana/kiwi/x", "ana/..", "ana/.", "../kiwi",
		"ana/ki wi", "ana/kiwi?x", "https://github.com/ana/kiwi", "-ana/kiwi"} {
		_, err := ParseRepo(bad)
		require.ErrorIs(t, err, ErrBadRepo, bad)
	}
}

// fakeRepos answers GET /repos/<repo> with the JSON given for each repo.
func fakeRepos(t *testing.T, repos map[string]string) *GitHub {
	t.Helper()
	mux := http.NewServeMux()
	for repo, body := range repos {
		mux.HandleFunc("GET /api/repos/"+repo, func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(body))
		})
	}
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return &GitHub{APIBase: server.URL + "/api", RawBase: server.URL + "/raw", Client: server.Client()}
}

func TestOnlyPublicLicensedReposAreOpenSource(t *testing.T) {
	gh := fakeRepos(t, map[string]string{
		"ana/livre":    `{"private":false,"license":{"spdx_id":"MIT"}}`,
		"ana/sem":      `{"private":false,"license":null}`,
		"ana/fechado":  `{"private":true,"license":{"spdx_id":"MIT"}}`,
		"ana/estranho": `{"license":{"spdx_id":"MIT"}}`,
		"ana/quebrado": `nada`,
	})

	require.NoError(t, gh.CheckOpenSource(t.Context(), "ana/livre"))
	require.ErrorIs(t, gh.CheckOpenSource(t.Context(), "ana/sem"), ErrNotOpenSource)
	require.ErrorIs(t, gh.CheckOpenSource(t.Context(), "ana/fechado"), ErrNotOpenSource)
	require.ErrorIs(t, gh.CheckOpenSource(t.Context(), "ana/estranho"), ErrNotOpenSource, "sem private explícito não conta como público")
	require.ErrorIs(t, gh.CheckOpenSource(t.Context(), "ana/nada"), ErrRepoNotFound)
	err := gh.CheckOpenSource(t.Context(), "ana/quebrado")
	require.Error(t, err)
	require.NotErrorIs(t, err, ErrNotOpenSource)
}
