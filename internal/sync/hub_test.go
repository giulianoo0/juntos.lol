package sync

import (
	"errors"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
)

func TestHubSyncFlow(t *testing.T) {
	hub, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	hostWelcome := helloHubClient(t, host, "host", 11)
	require.Equal(t, "m1", hostWelcome.MemberID)
	require.Equal(t, "m1", hostWelcome.ControllerID)
	require.NotNil(t, hostWelcome.State)
	require.NotEmpty(t, hostWelcome.Capability)
	require.True(t, hub.AuthorizeMember("r1", "m1", hostWelcome.Capability))
	require.False(t, hub.AuthorizeMember("r1", "m1", "wrong"))

	require.NoError(t, host.WriteJSON(Inbound{Type: "play", PositionMs: 30_000, Rate: 1}))
	state := readHubEvent(t, host)
	require.Equal(t, "state", state.Type)
	require.True(t, state.State.Playing)
	require.Equal(t, int64(30_000), state.State.PositionMs)
	require.Greater(t, state.State.ServerTimeMs, int64(0))

	guest := dialHubWS(t, server)
	guestWelcome := helloHubClient(t, guest, "guest", 12)
	require.Equal(t, "m2", guestWelcome.MemberID)
	require.Equal(t, "m1", guestWelcome.ControllerID)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "pause", PositionMs: 31_000}))
	refused := readHubEvent(t, guest)
	require.Equal(t, "error", refused.Type)
	require.Equal(t, "not_controller", refused.ErrCode)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 99}))
	pong := readHubEvent(t, guest)
	require.Equal(t, "pong", pong.Type)
	require.Equal(t, int64(99), pong.ClientTimeMs)

	hub.NotifyStatus("r1", "ready")
	status := readHubEvent(t, host)
	require.Equal(t, "roomStatus", status.Type)
	require.Equal(t, "ready", status.Status)

	hub.NotifyRoomUpdated("r1")
	update := readHubEvent(t, host)
	require.Equal(t, "roomUpdated", update.Type)
	require.Empty(t, update.Status)
}

func TestHubChatAndControllerPromotion(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "chat", Text: "oi"}))
	for _, client := range []*websocket.Conn{host, guest} {
		event := readHubEvent(t, client)
		require.Equal(t, "chat", event.Type)
		require.Equal(t, "guest", event.Message.Author)
		require.Equal(t, "oi", event.Message.Text)
	}

	third := dialHubWS(t, server)
	helloHubClient(t, third, "third", 3)
	require.Equal(t, "members", readHubEvent(t, host).Type)
	require.Equal(t, "members", readHubEvent(t, guest).Type)
	require.NoError(t, host.Close())

	promoted := readHubEvent(t, guest)
	require.Equal(t, "members", promoted.Type)
	require.Equal(t, "m2", promoted.ControllerID)
	require.Equal(t, promoted.ControllerID, readHubEvent(t, third).ControllerID)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "pause", PositionMs: 31_000, Rate: 1}))
	for _, client := range []*websocket.Conn{guest, third} {
		event := readHubEvent(t, client)
		require.Equal(t, "state", event.Type)
		require.False(t, event.State.Playing)
	}
}

func TestHubIgnoresControlTakeoverMessages(t *testing.T) {
	_, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	guestWelcome := helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "m2", guestWelcome.MemberID)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "claim"}))
	require.NoError(t, guest.WriteJSON(Inbound{Type: "delegate", TargetID: "m2"}))
	require.NoError(t, guest.WriteJSON(Inbound{Type: "play", PositionMs: 5_000, Rate: 1}))
	require.Equal(t, "not_controller", readHubEvent(t, guest).ErrCode)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 9}))
	require.Equal(t, "pong", readHubEvent(t, guest).Type)
	stored, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.Equal(t, "m1", stored.ControllerID)
}

func TestHubRejectsRoomFull(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 1, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "hello", Nickname: "guest"}))
	event := readHubEvent(t, guest)
	require.Equal(t, "error", event.Type)
	require.Equal(t, "room_full", event.ErrCode)
}

func TestHubDoesNotAcceptNicknameFromURL(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	client := dialHubWS(t, server, "nickname=url-name")
	require.NoError(t, client.WriteJSON(Inbound{Type: "hello"}))
	event := readHubEvent(t, client)
	require.Equal(t, "error", event.Type)
	require.Equal(t, "invalid_hello", event.ErrCode)
}

func TestHubIdleCleanupRemovesRoomAndFiles(t *testing.T) {
	hub, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	hub.idleAfter = 20 * time.Millisecond
	require.NoError(t, store.SetStatus(t.Context(), "r1", "ready"))
	roomDir := filepath.Join(hub.cfg.DataDir, "rooms", "r1")
	require.NoError(t, os.MkdirAll(roomDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(roomDir, "media"), []byte("x"), 0o644))
	client := dialHubWS(t, server)
	helloHubClient(t, client, "host", 1)
	require.NoError(t, client.Close())

	require.Eventually(t, func() bool {
		_, err := store.Get(t.Context(), "r1")
		_, statErr := os.Stat(roomDir)
		return errors.Is(err, room.ErrNotFound) && os.IsNotExist(statErr)
	}, time.Second, 10*time.Millisecond)
}

func TestHubIdleCleanupReclaimsTheRoomsMedia(t *testing.T) {
	hub, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 90})
	hub.idleAfter = 20 * time.Millisecond
	bucket := hub.bucket.(*objectstore.Fake)
	require.NoError(t, store.SetStatus(t.Context(), "r1", "ready"))
	for _, key := range []string{"rooms/r1/g0/hls/stream_0_000.m4s", "rooms/other/g0/hls/stream_0_000.m4s"} {
		require.NoError(t, bucket.Put(t.Context(), key, strings.NewReader("x"), 1, "", ""))
	}
	client := dialHubWS(t, server)
	helloHubClient(t, client, "host", 1)
	require.NoError(t, client.Close())

	require.Eventually(t, func() bool {
		return len(bucket.Keys()) == 1
	}, time.Second, 10*time.Millisecond)
	require.Equal(t, []string{"rooms/other/g0/hls/stream_0_000.m4s"}, bucket.Keys())
}

func TestHubIdleCleanupKeepsTheMediaOfAnActiveUpload(t *testing.T) {
	hub, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 90})
	hub.idleAfter = 20 * time.Millisecond
	bucket := hub.bucket.(*objectstore.Fake)
	require.NoError(t, store.SetStatus(t.Context(), "r1", "uploading"))
	require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/preview_stream_0_000000.m4s",
		strings.NewReader("x"), 1, "", ""))
	client := dialHubWS(t, server)
	helloHubClient(t, client, "host", 1)
	require.NoError(t, client.Close())

	require.Eventually(t, func() bool {
		hub.mu.Lock()
		defer hub.mu.Unlock()
		return hub.rooms["r1"] == nil
	}, time.Second, 10*time.Millisecond)
	require.Len(t, bucket.Keys(), 1)
}

func TestHubIdleCleanupKeepsARoomWhoseWorkIsUnfinished(t *testing.T) {
	tests := []struct {
		name     string
		received int64
		total    int64
	}{
		{name: "source still arriving", received: 500, total: 1000},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hub, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 90})
			hub.idleAfter = 20 * time.Millisecond
			bucket := hub.bucket.(*objectstore.Fake)
			require.NoError(t, store.SetStatus(t.Context(), "r1", "ready"))
			require.NoError(t, store.SetIngestProgress(t.Context(), "r1", tt.received, tt.total))
			require.NoError(t, bucket.Put(t.Context(), "rooms/r1/g0/hls/preview_stream_0_000000.m4s",
				strings.NewReader("x"), 1, "", ""))
			roomDir := filepath.Join(hub.cfg.DataDir, "rooms", "r1")
			require.NoError(t, os.MkdirAll(roomDir, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(roomDir, "partial"), []byte("x"), 0o644))
			client := dialHubWS(t, server)
			helloHubClient(t, client, "host", 1)
			require.NoError(t, client.Close())

			require.Eventually(t, func() bool {
				hub.mu.Lock()
				defer hub.mu.Unlock()
				return hub.rooms["r1"] == nil
			}, time.Second, 10*time.Millisecond)

			_, err := store.Get(t.Context(), "r1")
			require.NoError(t, err)
			require.FileExists(t, filepath.Join(roomDir, "partial"))
			require.Len(t, bucket.Keys(), 1)
		})
	}
}

func TestHubIdleCleanupReclaimsARoomWhoseWorkIsDone(t *testing.T) {
	hub, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 90})
	hub.idleAfter = 20 * time.Millisecond
	require.NoError(t, store.SetStatus(t.Context(), "r1", "ready"))
	require.NoError(t, store.SetIngestProgress(t.Context(), "r1", 1000, 1000))
	client := dialHubWS(t, server)
	helloHubClient(t, client, "host", 1)
	require.NoError(t, client.Close())

	require.Eventually(t, func() bool {
		_, err := store.Get(t.Context(), "r1")
		return errors.Is(err, room.ErrNotFound)
	}, time.Second, 10*time.Millisecond)
}

func TestHubIdleCleanupPreservesActiveUpload(t *testing.T) {
	for _, status := range []string{"uploading", "processing"} {
		t.Run(status, func(t *testing.T) {
			hub, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
			hub.idleAfter = 20 * time.Millisecond
			require.NoError(t, store.SetStatus(t.Context(), "r1", status))
			roomDir := filepath.Join(hub.cfg.DataDir, "rooms", "r1")
			require.NoError(t, os.MkdirAll(roomDir, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(roomDir, "partial"), []byte("x"), 0o644))
			client := dialHubWS(t, server)
			helloHubClient(t, client, "host", 1)
			require.NoError(t, client.Close())

			require.Eventually(t, func() bool {
				hub.mu.Lock()
				defer hub.mu.Unlock()
				return hub.rooms["r1"] == nil
			}, time.Second, 10*time.Millisecond)
			storedRoom, err := store.Get(t.Context(), "r1")
			require.NoError(t, err)
			require.Equal(t, status, storedRoom.Status)
			require.Empty(t, storedRoom.ControllerID)
			require.FileExists(t, filepath.Join(roomDir, "partial"))
		})
	}
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
	if cfg.RoomIdleSeconds == 0 {
		cfg.RoomIdleSeconds = 90
	}
	cfg.DataDir = t.TempDir()
	hub := NewHub(store, cfg, objectstore.NewFake())
	t.Cleanup(hub.Close)
	router := gin.New()
	router.GET("/ws/rooms/:id", hub.HandleWS)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return hub, store, server
}

func dialHubWS(t *testing.T, server *httptest.Server, rawQuery ...string) *websocket.Conn {
	t.Helper()
	serverURL, err := url.Parse(server.URL)
	require.NoError(t, err)
	serverURL.Scheme = "ws"
	serverURL.Path = "/ws/rooms/r1"
	if len(rawQuery) > 0 {
		serverURL.RawQuery = rawQuery[0]
	}
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

func TestHubGateReleasesOnQuorum(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	welcome := helloHubClient(t, host, "host", 1)
	require.NotNil(t, welcome.Gating)
	require.True(t, *welcome.Gating)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, host.WriteJSON(Inbound{Type: "play", PositionMs: 30_000, Rate: 1}))
	for _, conn := range []*websocket.Conn{host, guest} {
		parked := readHubEvent(t, conn)
		require.Equal(t, "state", parked.Type)
		require.False(t, parked.State.Playing)
		require.Equal(t, int64(30_000), parked.State.PositionMs)
		waiting := readHubEvent(t, conn)
		require.Equal(t, "waiting", waiting.Type)
		require.Equal(t, int64(30_000), waiting.TargetMs)
		require.Len(t, waiting.Readiness, 2)
		for _, member := range waiting.Readiness {
			require.False(t, member.Ready)
		}
	}

	require.NoError(t, host.WriteJSON(Inbound{Type: "ready", PositionMs: 30_000, BufferAheadMs: 5_000}))
	waiting := readHubEvent(t, host)
	require.Equal(t, "waiting", waiting.Type)
	byMember := map[string]MemberReadiness{}
	for _, member := range waiting.Readiness {
		byMember[member.MemberID] = member
	}
	require.True(t, byMember["m1"].Ready)
	require.False(t, byMember["m2"].Ready)
	require.Equal(t, "waiting", readHubEvent(t, guest).Type)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "ready", PositionMs: 30_100, BufferAheadMs: GateReadyBufferMs}))
	for _, conn := range []*websocket.Conn{host, guest} {
		released := readHubEvent(t, conn)
		require.Equal(t, "state", released.Type)
		require.True(t, released.State.Playing)
		require.Equal(t, int64(30_000), released.State.PositionMs)
	}
}

func TestHubGateReleasesOnTimeout(t *testing.T) {
	hub, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	hub.gateTimeout = 60 * time.Millisecond
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, host.WriteJSON(Inbound{Type: "play", PositionMs: 10_000, Rate: 1}))
	require.Equal(t, "state", readHubEvent(t, host).Type)
	require.Equal(t, "waiting", readHubEvent(t, host).Type)

	third := dialHubWS(t, server)
	thirdWelcome := helloHubClient(t, third, "third", 3)
	require.False(t, thirdWelcome.State.Playing)
	require.Equal(t, int64(10_000), thirdWelcome.State.PositionMs)
	require.Equal(t, "waiting", readHubEvent(t, third).Type)

	deadline := time.Now().Add(2 * time.Second)
	for _, conn := range []*websocket.Conn{host, guest, third} {
		for {
			require.Less(t, time.Now().UnixMilli(), deadline.UnixMilli())
			event := readHubEvent(t, conn)
			if event.Type == "state" && event.State.Playing {
				require.Equal(t, int64(10_000), event.State.PositionMs)
				break
			}
		}
	}
}

func TestHubGateDisconnectDoesNotHangRoom(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, host.WriteJSON(Inbound{Type: "play", PositionMs: 5_000, Rate: 1}))
	require.Equal(t, "state", readHubEvent(t, host).Type)
	require.Equal(t, "waiting", readHubEvent(t, host).Type)
	require.NoError(t, host.WriteJSON(Inbound{Type: "ready", PositionMs: 5_000, BufferAheadMs: 5_000}))
	require.Equal(t, "waiting", readHubEvent(t, host).Type)

	require.NoError(t, guest.Close())
	for {
		event := readHubEvent(t, host)
		if event.Type == "state" {
			require.True(t, event.State.Playing)
			require.Equal(t, int64(5_000), event.State.PositionMs)
			break
		}
		require.Equal(t, "members", event.Type)
	}
}

func TestHubGatingSettingIsControllerOnly(t *testing.T) {
	_, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	disabled := false
	require.NoError(t, guest.WriteJSON(Inbound{Type: "gating", Enabled: &disabled}))
	require.Equal(t, "not_controller", readHubEvent(t, guest).ErrCode)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 7}))
	require.Equal(t, "pong", readHubEvent(t, guest).Type)
	stored, err := store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.True(t, stored.GatingEnabled)

	require.NoError(t, host.WriteJSON(Inbound{Type: "gating", Enabled: &disabled}))
	for _, conn := range []*websocket.Conn{host, guest} {
		event := readHubEvent(t, conn)
		require.Equal(t, "gating", event.Type)
		require.NotNil(t, event.Gating)
		require.False(t, *event.Gating)
	}
	stored, err = store.Get(t.Context(), "r1")
	require.NoError(t, err)
	require.False(t, stored.GatingEnabled)

	require.NoError(t, host.WriteJSON(Inbound{Type: "play", PositionMs: 1_000, Rate: 1}))
	for _, conn := range []*websocket.Conn{host, guest} {
		event := readHubEvent(t, conn)
		require.Equal(t, "state", event.Type)
		require.True(t, event.State.Playing)
	}
}

func TestHubGateSkipsScreenRooms(t *testing.T) {
	_, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	now := time.Now()
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", Status: "ready", SourceKind: room.SourceScreen, ControllerID: "m1",
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}))
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, host.WriteJSON(Inbound{Type: "play", PositionMs: 0, Rate: 1}))
	for _, conn := range []*websocket.Conn{host, guest} {
		event := readHubEvent(t, conn)
		require.Equal(t, "state", event.Type)
		require.True(t, event.State.Playing)
	}
}

func startedRoom(t *testing.T, server *httptest.Server) (host, guest *websocket.Conn) {
	t.Helper()
	host = dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest = dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, host.WriteJSON(Inbound{Type: "play", PositionMs: 30_000, Rate: 1}))
	for _, conn := range []*websocket.Conn{host, guest} {
		require.Equal(t, "state", readHubEvent(t, conn).Type)
		require.Equal(t, "waiting", readHubEvent(t, conn).Type)
	}
	require.NoError(t, host.WriteJSON(Inbound{Type: "ready", PositionMs: 30_000, BufferAheadMs: 5_000}))
	require.Equal(t, "waiting", readHubEvent(t, host).Type)
	require.Equal(t, "waiting", readHubEvent(t, guest).Type)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "ready", PositionMs: 30_000, BufferAheadMs: 5_000}))
	for _, conn := range []*websocket.Conn{host, guest} {
		released := readHubEvent(t, conn)
		require.Equal(t, "state", released.Type)
		require.True(t, released.State.Playing)
	}
	return host, guest
}

func TestHubStopsTheRoomWhenSomeoneStallsMidPlayback(t *testing.T) {
	hub, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	hub.gateTimeout = time.Minute
	hub.stallCooldown = 0
	host, guest := startedRoom(t, server)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "ready", PositionMs: 45_000, BufferAheadMs: 0, Stalled: true}))

	for _, conn := range []*websocket.Conn{host, guest} {
		parked := readHubEvent(t, conn)
		require.Equal(t, "state", parked.Type, "the room did not stop for the stall")
		require.False(t, parked.State.Playing)
		waiting := readHubEvent(t, conn)
		require.Equal(t, "waiting", waiting.Type)
	}
}

func TestHubDoesNotStopForAStallReportedOverAFullBuffer(t *testing.T) {
	hub, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	hub.gateTimeout = time.Minute
	hub.stallCooldown = 0
	host, guest := startedRoom(t, server)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "ready", PositionMs: 45_000, BufferAheadMs: 120_000, Stalled: true}))

	for _, conn := range []*websocket.Conn{host, guest} {
		require.NoError(t, conn.SetReadDeadline(time.Now().Add(300*time.Millisecond)))
		var event Outbound
		require.Error(t, conn.ReadJSON(&event), "the room stopped for a stall over %d ms of buffer: %+v", 120_000, event)
	}
}

func TestHubIgnoreLetsTheRoomCarryOnWithoutTheStalledMember(t *testing.T) {
	hub, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	hub.gateTimeout = time.Minute
	hub.stallCooldown = 0
	host, guest := startedRoom(t, server)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "ready", PositionMs: 45_000, BufferAheadMs: 0, Stalled: true}))
	var target int64
	for _, conn := range []*websocket.Conn{host, guest} {
		require.Equal(t, "state", readHubEvent(t, conn).Type)
		waiting := readHubEvent(t, conn)
		require.Equal(t, "waiting", waiting.Type)
		target = waiting.TargetMs
	}
	require.NoError(t, host.WriteJSON(Inbound{Type: "ready", PositionMs: target, BufferAheadMs: 5_000}))
	require.Equal(t, "waiting", readHubEvent(t, host).Type)
	require.Equal(t, "waiting", readHubEvent(t, guest).Type)

	require.NoError(t, host.WriteJSON(Inbound{Type: "ignore", TargetID: "m2"}))

	for _, conn := range []*websocket.Conn{host, guest} {
		released := readHubEvent(t, conn)
		require.Equal(t, "state", released.Type, "ignoring did not restart the room")
		require.True(t, released.State.Playing)
	}
}

func TestHubIgnoreIsTheControllersAlone(t *testing.T) {
	hub, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	hub.gateTimeout = time.Minute
	hub.stallCooldown = 0
	host, guest := startedRoom(t, server)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "ready", PositionMs: 45_000, BufferAheadMs: 0, Stalled: true}))
	var target int64
	for _, conn := range []*websocket.Conn{host, guest} {
		require.Equal(t, "state", readHubEvent(t, conn).Type)
		waiting := readHubEvent(t, conn)
		require.Equal(t, "waiting", waiting.Type)
		target = waiting.TargetMs
	}

	require.NoError(t, guest.WriteJSON(Inbound{Type: "ignore", TargetID: "m2"}))
	require.NoError(t, host.WriteJSON(Inbound{Type: "ready", PositionMs: target, BufferAheadMs: 5_000}))

	waiting := readHubEvent(t, host)
	require.Equal(t, "waiting", waiting.Type, "the room resumed on a viewer's say-so")
	byMember := map[string]MemberReadiness{}
	for _, member := range waiting.Readiness {
		byMember[member.MemberID] = member
	}
	require.False(t, byMember["m2"].Ignored)
	require.False(t, byMember["m2"].Ready)
}

func TestHubDoesNotStopForAStalledMemberAlone(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)

	require.NoError(t, host.WriteJSON(Inbound{Type: "play", PositionMs: 10_000, Rate: 1}))
	playing := readHubEvent(t, host)
	require.Equal(t, "state", playing.Type)
	require.True(t, playing.State.Playing, "a lone viewer was gated")

	require.NoError(t, host.WriteJSON(Inbound{Type: "ready", PositionMs: 12_000, BufferAheadMs: 0, Stalled: true}))
	require.NoError(t, host.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 5}))
	require.Equal(t, "pong", readHubEvent(t, host).Type, "the room reacted to a solo stall")
}

func TestHubTitleRequestBroadcasts(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	request := &TitleRequest{MetaID: "tt0903747", MetaType: "series", Name: "Breaking Bad", Poster: "https://img/poster.jpg", Season: 1, Episode: 2}
	require.NoError(t, guest.WriteJSON(Inbound{Type: "titleRequest", Title: request}))
	for _, conn := range []*websocket.Conn{host, guest} {
		event := readHubEvent(t, conn)
		require.Equal(t, "titleRequest", event.Type)
		require.Equal(t, "m2", event.MemberID)
		require.NotNil(t, event.Title)
		require.Equal(t, "tt0903747", event.Title.MetaID)
		require.Equal(t, "series", event.Title.MetaType)
		require.Equal(t, "Breaking Bad", event.Title.Name)
		require.Equal(t, "guest", event.Title.From)
		require.Equal(t, 1, event.Title.Season)
		require.Equal(t, 2, event.Title.Episode)
	}
}

func TestHubTitleRequestValidationAndRateLimit(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, host.WriteJSON(Inbound{Type: "titleRequest", Title: &TitleRequest{MetaID: "tt1", MetaType: "movie", Name: "X"}}))
	require.NoError(t, guest.WriteJSON(Inbound{Type: "titleRequest"}))
	require.NoError(t, guest.WriteJSON(Inbound{Type: "titleRequest", Title: &TitleRequest{MetaID: "", MetaType: "movie", Name: "X"}}))
	require.NoError(t, guest.WriteJSON(Inbound{Type: "titleRequest", Title: &TitleRequest{MetaID: "tt1", MetaType: "other", Name: "X"}}))

	require.NoError(t, guest.WriteJSON(Inbound{Type: "titleRequest", Title: &TitleRequest{MetaID: "tt2", MetaType: "movie", Name: "First"}}))
	event := readHubEvent(t, guest)
	require.Equal(t, "titleRequest", event.Type)
	require.Equal(t, "First", event.Title.Name)
	require.NoError(t, guest.WriteJSON(Inbound{Type: "titleRequest", Title: &TitleRequest{MetaID: "tt3", MetaType: "movie", Name: "Second"}}))
	require.NoError(t, guest.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 7}))
	require.Equal(t, "pong", readHubEvent(t, guest).Type)

	require.Equal(t, "titleRequest", readHubEvent(t, host).Type)
	require.NoError(t, host.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 8}))
	require.Equal(t, "pong", readHubEvent(t, host).Type)
}

func TestHubOwnerTokenTakesControlBack(t *testing.T) {
	_, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", FileName: "movie.mkv", Status: "processing", ControllerID: "m1",
		OwnerToken: "secret-owner-token", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour),
	}))

	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, host.Close())
	promoted := readHubEvent(t, guest)
	require.Equal(t, "members", promoted.Type)
	require.Equal(t, "m2", promoted.ControllerID)

	reloaded := dialHubWS(t, server)
	require.NoError(t, reloaded.WriteJSON(Inbound{
		Type: "hello", Nickname: "host", ClientTimeMs: 3, OwnerToken: "secret-owner-token",
	}))
	welcome := readHubEvent(t, reloaded)
	require.Equal(t, "welcome", welcome.Type)
	require.Equal(t, welcome.MemberID, welcome.ControllerID)
	require.Equal(t, "pong", readHubEvent(t, reloaded).Type)

	require.NoError(t, reloaded.WriteJSON(Inbound{Type: "pause", PositionMs: 4_000, Rate: 1}))
	require.Equal(t, "state", readHubEvent(t, reloaded).Type)
}

func TestHubWrongOwnerTokenKeepsController(t *testing.T) {
	_, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", FileName: "movie.mkv", Status: "processing", ControllerID: "m1",
		OwnerToken: "secret-owner-token", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour),
	}))
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)

	guest := dialHubWS(t, server)
	require.NoError(t, guest.WriteJSON(Inbound{
		Type: "hello", Nickname: "guest", ClientTimeMs: 2, OwnerToken: "not-the-token",
	}))
	welcome := readHubEvent(t, guest)
	require.Equal(t, "m1", welcome.ControllerID)
	require.Equal(t, "pong", readHubEvent(t, guest).Type)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	require.NoError(t, guest.WriteJSON(Inbound{Type: "pause", PositionMs: 1_000}))
	require.Equal(t, "not_controller", readHubEvent(t, guest).ErrCode)
}

func TestHubStaleControllerIDDoesNotLockOutTheRoom(t *testing.T) {
	_, store, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	require.NoError(t, store.Create(t.Context(), &room.Room{
		ID: "r1", FileName: "movie.mkv", Status: "processing", ControllerID: "m7",
		CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour),
	}))

	host := dialHubWS(t, server)
	welcome := helloHubClient(t, host, "host", 1)
	require.Equal(t, "m1", welcome.MemberID)
	require.Equal(t, "m1", welcome.ControllerID)

	require.NoError(t, host.WriteJSON(Inbound{Type: "pause", PositionMs: 2_000, Rate: 1}))
	require.Equal(t, "state", readHubEvent(t, host).Type)
}

func TestRoomSendToleratesNilTarget(t *testing.T) {
	require.NotPanics(t, func() {
		connection := &roomConn{id: "r1"}
		connection.send(nil, Outbound{Type: "error", ErrCode: "internal_error"})
	})
}
