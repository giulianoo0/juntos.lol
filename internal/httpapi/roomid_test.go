package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// A room id is read off one screen and typed into another, so it may only use
// characters that survive being read aloud and retyped. The default nanoid
// alphabet mixes cases and adds - and _, which this guards against coming back.
func TestCreatedRoomIDsAreCapitalsAndDigitsOnly(t *testing.T) {
	s := newTestStore(t)
	e := gin.New()
	RegisterRoomRoutes(e.Group("/api"), s, testCfg(t))
	shape := regexp.MustCompile(`^[A-Z0-9]{8}$`)

	for i := 0; i < 40; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/rooms",
			strings.NewReader(`{"fileName":"movie.mkv","nickname":"giuli"}`))
		req.Header.Set("Content-Type", "application/json")
		e.ServeHTTP(w, req)
		require.Equal(t, http.StatusCreated, w.Code)

		var resp struct{ ID string }
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
		require.Regexp(t, shape, resp.ID)

		// And it has to be a real room at that id, not merely a tidy string.
		_, err := s.Get(context.Background(), resp.ID)
		require.NoError(t, err)
	}
}
