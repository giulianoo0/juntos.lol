package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestServerServesFrontendRoutesWithoutMaskingAPIs(t *testing.T) {
	webDir := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(webDir, "assets"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(webDir, "index.html"), []byte("<main>ss</main>"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(webDir, "assets", "app.js"), []byte("ready"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(webDir, "oembed.json"), []byte(`{"type":"link"}`), 0o644))

	cfg := testCfg(t)
	cfg.WebDir = webDir
	server := NewServer(cfg, newTestStore(t), nil)

	for _, test := range []struct {
		path       string
		statusCode int
		body       string
	}{
		{path: "/room/abc", statusCode: http.StatusOK, body: "<main>ss</main>"},
		{path: "/assets/app.js", statusCode: http.StatusOK, body: "ready"},
		{path: "/oembed.json", statusCode: http.StatusOK, body: `{"type":"link"}`},
		{path: "/api/missing", statusCode: http.StatusNotFound},
		{path: "/media/missing", statusCode: http.StatusNotFound},
		{path: "/ws/missing", statusCode: http.StatusNotFound},
	} {
		t.Run(test.path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)

			require.Equal(t, test.statusCode, response.Code)
			require.Equal(t, "no-referrer", response.Header().Get("Referrer-Policy"))
			require.Equal(t, "nosniff", response.Header().Get("X-Content-Type-Options"))
			require.Equal(t, "DENY", response.Header().Get("X-Frame-Options"))
			if len(test.path) >= 5 && (test.path[:5] == "/api/" || test.path[:4] == "/ws/") {
				require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
			}
			if test.body != "" {
				require.Equal(t, test.body, response.Body.String())
			}
		})
	}
}

func newServerWithWebDir(t *testing.T, webDir string) http.Handler {
	t.Helper()
	cfg := testCfg(t)
	cfg.WebDir = webDir
	return NewServer(cfg, newTestStore(t), nil)
}

func TestDocsPathDoesNotFallBackToTheApp(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "docs"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "docs", "index.html"), []byte("<h1>docs</h1>"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "index.html"), []byte("<h1>app</h1>"), 0o644))
	server := newServerWithWebDir(t, dir)

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/docs/", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), "docs")

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/docs/nope", nil))
	require.Equal(t, http.StatusNotFound, rec.Code, "a wrong docs address must not open the app shell")
}

func TestPluginWorkerIsServedWithItsOwnPolicy(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "assets", "plugin-worker"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "assets", "plugin-worker", "abc.js"), []byte("//"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "assets", "app-abc.js"), []byte("//"), 0o644))
	server := newServerWithWebDir(t, dir)

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/plugin-worker/abc.js", nil))
	policy := rec.Header().Get("Content-Security-Policy")
	require.Contains(t, policy, "default-src 'none'")
	// blob: is what lets the plugin's own module be imported at all; without
	// it the sandbox does not run. https must not be there.
	require.Contains(t, policy, "script-src blob:")
	require.NotContains(t, policy, "https:")

	// And the app itself must not inherit it, or nothing would reach /api.
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/app-abc.js", nil))
	require.Empty(t, rec.Header().Get("Content-Security-Policy"))
}
