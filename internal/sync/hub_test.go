package sync

import (
	"errors"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

func TestHubSyncFlow(t *testing.T) {
	hub, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleMinutes: 10})
	host := dialHubWS(t, server, "host")
	hostWelcome := helloHubClient(t, host, "host", 11)
	require.Equal(t, "m1", hostWelcome.MemberID)
	require.Equal(t, "m1", hostWelcome.ControllerID)
	require.NotNil(t, hostWelcome.State)

	require.NoError(t, host.WriteJSON(Inbound{Type: "play", PositionMs: 30_000, Rate: 1}))
	state := readHubEvent(t, host)
	require.Equal(t, "state", state.Type)
	require.True(t, state.State.Playing)
	require.Equal(t, int64(30_000), state.State.PositionMs)
	require.Greater(t, state.State.ServerTimeMs, int64(0))

	guest := dialHubWS(t, server, "guest")
	guestWelcome := helloHubClient(t, guest, "guest", 12)
	require.Equal(t, "m2", guestWelcome.MemberID)
	require.Equal(t, "m1", guestWelcome.ControllerID)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "pause", PositionMs: 31_000}))
	require.NoError(t, guest.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 99}))
	pong := readHubEvent(t, guest)
	require.Equal(t, "pong", pong.Type)
	require.Equal(t, int64(99), pong.ClientTimeMs)

	hub.NotifyStatus("r1", "ready")
	status := readHubEvent(t, host)
	require.Equal(t, "roomStatus", status.Type)
	require.Equal(t, "ready", status.Status)
}

func TestHubChatDelegationAndControllerPromotion(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleMinutes: 10})
	host := dialHubWS(t, server, "host")
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server, "guest")
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "chat", Text: "oi"}))
	for _, client := range []*websocket.Conn{host, guest} {
		event := readHubEvent(t, client)
		require.Equal(t, "chat", event.Type)
		require.Equal(t, "guest", event.Message.Author)
		require.Equal(t, "oi", event.Message.Text)
	}

	require.NoError(t, host.WriteJSON(Inbound{Type: "delegate", TargetID: "m2"}))
	for _, client := range []*websocket.Conn{host, guest} {
		event := readHubEvent(t, client)
		require.Equal(t, "members", event.Type)
		require.Equal(t, "m2", event.ControllerID)
	}
	require.NoError(t, guest.WriteJSON(Inbound{Type: "pause", PositionMs: 31_000, Rate: 1}))
	for _, client := range []*websocket.Conn{host, guest} {
		event := readHubEvent(t, client)
		require.Equal(t, "state", event.Type)
		require.False(t, event.State.Playing)
	}

	third := dialHubWS(t, server, "third")
	helloHubClient(t, third, "third", 3)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	require.Equal(t, "members", readHubEvent(t, guest).Type)
	require.NoError(t, guest.Close())

	promoted := readHubEvent(t, host)
	require.Equal(t, "members", promoted.Type)
	require.Equal(t, "m1", promoted.ControllerID)
	require.Equal(t, promoted.ControllerID, readHubEvent(t, third).ControllerID)
}

func TestHubRejectsRoomFull(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 1, RoomIdleMinutes: 10})
	host := dialHubWS(t, server, "host")
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server, "guest")
	require.NoError(t, guest.WriteJSON(Inbound{Type: "hello", Nickname: "guest"}))
	event := readHubEvent(t, guest)
	require.Equal(t, "error", event.Type)
	require.Equal(t, "room_full", event.ErrCode)
}

func TestHubIdleCleanupRemovesRoomAndFiles(t *testing.T) {
	hub, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleMinutes: 10})
	hub.idleAfter = 20 * time.Millisecond
	roomDir := filepath.Join(hub.cfg.DataDir, "rooms", "r1")
	require.NoError(t, os.MkdirAll(roomDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(roomDir, "media"), []byte("x"), 0o644))
	client := dialHubWS(t, server, "host")
	helloHubClient(t, client, "host", 1)
	require.NoError(t, client.Close())

	require.Eventually(t, func() bool {
		_, err := store.Get(t.Context(), "r1")
		_, statErr := os.Stat(roomDir)
		return errors.Is(err, room.ErrNotFound) && os.IsNotExist(statErr)
	}, time.Second, 10*time.Millisecond)
}

func newHubTestServer(t *testing.T, cfg config.Config) (*Hub, *room.Store, *httptest.Server) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { require.NoError(t, rdb.Close()) })
	store := room.NewStore(rdb, time.Hour)
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", FileName: "movie.mkv", Status: "processing", ControllerID: "m1",
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	if cfg.MaxParticipants == 0 {
		cfg.MaxParticipants = 20
	}
	if cfg.RoomIdleMinutes == 0 {
		cfg.RoomIdleMinutes = 10
	}
	cfg.DataDir = t.TempDir()
	hub := NewHub(store, cfg)
	t.Cleanup(hub.Close)
	router := gin.New()
	router.GET("/ws/rooms/:id", hub.HandleWS)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return hub, store, server
}

func dialHubWS(t *testing.T, server *httptest.Server, nickname string) *websocket.Conn {
	t.Helper()
	serverURL, err := url.Parse(server.URL)
	require.NoError(t, err)
	serverURL.Scheme = "ws"
	serverURL.Path = "/ws/rooms/r1"
	query := serverURL.Query()
	query.Set("nickname", nickname)
	serverURL.RawQuery = query.Encode()
	conn, response, err := websocket.DefaultDialer.Dial(serverURL.String(), nil)
	if response != nil {
		defer response.Body.Close()
	}
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func helloHubClient(t *testing.T, conn *websocket.Conn, nickname string, clientTimeMs int64) Outbound {
	t.Helper()
	require.NoError(t, conn.WriteJSON(Inbound{
		Type: "hello", Nickname: nickname, ClientTimeMs: clientTimeMs,
	}))
	welcome := readHubEvent(t, conn)
	require.Equal(t, "welcome", welcome.Type)
	pong := readHubEvent(t, conn)
	require.Equal(t, "pong", pong.Type)
	require.Equal(t, clientTimeMs, pong.ClientTimeMs)
	require.Greater(t, pong.ServerTimeMs, int64(0))
	return welcome
}

func readHubEvent(t *testing.T, conn *websocket.Conn) Outbound {
	t.Helper()
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
	var event Outbound
	require.NoError(t, conn.ReadJSON(&event))
	return event
}
