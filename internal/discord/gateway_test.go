package discord

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"
)

func TestPresencesFollowTheGuildThroughTheGateway(t *testing.T) {
	identified := make(chan map[string]any, 1)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		require.NoError(t, err)
		defer conn.Close()
		require.NoError(t, conn.WriteJSON(map[string]any{"op": 10, "d": map[string]any{"heartbeat_interval": 45000}}))
		var identify map[string]any
		require.NoError(t, conn.ReadJSON(&identify))
		identified <- identify
		send := func(event string, d any) {
			require.NoError(t, conn.WriteJSON(map[string]any{"op": 0, "t": event, "s": 1, "d": d}))
		}
		send("GUILD_CREATE", map[string]any{"id": "other", "presences": []any{map[string]any{"user": map[string]any{"id": "u9"}, "status": "online"}}})
		send("GUILD_CREATE", map[string]any{
			"id": "g1",
			"presences": []any{
				map[string]any{"user": map[string]any{"id": "u1"}, "status": "online"},
				map[string]any{"user": map[string]any{"id": "u2"}, "status": "dnd"},
			},
			"members": []any{map[string]any{"user": map[string]any{"id": "u1", "avatar": "abc"}}},
		})
		send("PRESENCE_UPDATE", map[string]any{"guild_id": "g1", "user": map[string]any{"id": "u2"}, "status": "offline"})
		send("PRESENCE_UPDATE", map[string]any{"guild_id": "g1", "user": map[string]any{"id": "u3"}, "status": "idle"})
		<-release
	}))
	defer server.Close()
	defer close(release)

	var mu sync.Mutex
	var changes []PresenceChange
	presences := &Presences{
		Token: "tok", GuildID: "g1", URL: "ws" + strings.TrimPrefix(server.URL, "http"),
		OnChange: func(change PresenceChange) { mu.Lock(); changes = append(changes, change); mu.Unlock() },
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go presences.Run(ctx)

	identify := <-identified
	d := identify["d"].(map[string]any)
	require.Equal(t, "tok", d["token"])
	require.Equal(t, float64(intentGuilds|intentPresences), d["intents"])

	require.Eventually(t, func() bool { return presences.Status("u3") == StatusIdle }, 2*time.Second, 10*time.Millisecond)
	require.Equal(t, StatusOnline, presences.Status("u1"))
	require.Equal(t, "abc", presences.Avatar("u1"))
	require.Equal(t, StatusOffline, presences.Status("u2"), "quem saiu fica offline")
	require.Equal(t, StatusOffline, presences.Status("u9"), "outro servidor não conta")
	mu.Lock()
	defer mu.Unlock()
	require.Len(t, changes, 4)
}
