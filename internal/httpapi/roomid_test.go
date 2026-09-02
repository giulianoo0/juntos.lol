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

		_, err := s.Get(context.Background(), resp.ID)
		require.NoError(t, err)
	}
}
