package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPublicConfigTellsWhereExtensionsLive(t *testing.T) {
	cfg := testCfg(t)
	cfg.ExtensionBase = "santamagia.com"
	cfg.ExtensionScheme = "https"
	cfg.GitHubRawBase = "http://127.0.0.1:8797"
	cfg.ExtensionDefaults = []string{"addons"}
	server := NewServer(cfg, newTestStore(t), nil)

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "santamagia.com", body["extensionBase"])
	require.Equal(t, "https", body["extensionScheme"])
	require.Equal(t, "http://127.0.0.1:8797", body["extensionRaw"])
	require.Equal(t, []any{"addons"}, body["extensionDefaults"])
	require.NotContains(t, body, "catalogAddonUrl", "o catálogo saiu do site")
}
