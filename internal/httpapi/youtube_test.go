package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/worker"
)

func TestYoutubeVideoID(t *testing.T) {
	good := map[string]string{
		"https://www.youtube.com/watch?v=aqz-KE-bpKQ":          "aqz-KE-bpKQ",
		"https://youtube.com/watch?v=aqz-KE-bpKQ&t=10s":        "aqz-KE-bpKQ",
		"youtu.be/aqz-KE-bpKQ?si=abc":                          "aqz-KE-bpKQ",
		"https://m.youtube.com/watch?v=aqz-KE-bpKQ":            "aqz-KE-bpKQ",
		"https://music.youtube.com/watch?v=aqz-KE-bpKQ&list=x": "aqz-KE-bpKQ",
		"https://www.youtube.com/shorts/aqz-KE-bpKQ":           "aqz-KE-bpKQ",
		"https://www.youtube.com/live/aqz-KE-bpKQ?feature=s":   "aqz-KE-bpKQ",
		"https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ":   "aqz-KE-bpKQ",
	}
	for raw, want := range good {
		got, ok := YoutubeVideoID(raw)
		if !ok || got != want {
			t.Errorf("%s: got %q ok=%v, want %q", raw, got, ok, want)
		}
	}
	bad := []string{
		"", "https://vimeo.com/123", "https://www.youtube.com/playlist?list=PL1",
		"https://www.youtube.com/watch?v=short", "https://www.youtube.com/channel/UCx",
		"ftp://youtube.com/watch?v=aqz-KE-bpKQ", "https://notyoutube.com/watch?v=aqz-KE-bpKQ",
	}
	for _, raw := range bad {
		if id, ok := YoutubeVideoID(raw); ok {
			t.Errorf("%s: accepted as %q", raw, id)
		}
	}
	if got := CanonicalYoutubeURL("aqz-KE-bpKQ"); got != "https://www.youtube.com/watch?v=aqz-KE-bpKQ" {
		t.Errorf("canonical: %s", got)
	}
}

// With the fleet off, a YouTube link starts only from the desktop app.
func TestYoutubeOffTheFleetIsTheAppsAlone(t *testing.T) {
	gin.SetMode(gin.TestMode)
	e := gin.New()
	RegisterYoutubeRoutes(e.Group("/api"), config.Config{YoutubeFleetEnabled: false},
		TorrentAccess{Service: &worker.Service{}})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/youtube",
		strings.NewReader(`{"url":"https://youtu.be/aqz-KE-bpKQ"}`))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)

	require.Equal(t, http.StatusForbidden, w.Code)
	require.Contains(t, w.Body.String(), "app_only")
}

func TestValidRunID(t *testing.T) {
	for _, ok := range []string{"run_abc123", "r-1", "RUN"} {
		if !validRunID(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "run id", "run/1", "run\n"} {
		if validRunID(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}
