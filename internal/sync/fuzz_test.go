package sync

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
)

var inboundSeeds = []string{
	`{"type":"hello","nickname":"giuli","clientTimeMs":1}`,
	`{"type":"hello","nickname":"giuli","memberId":"m1","capability":"c","ownerToken":"o"}`,
	`{"type":"hello","nickname":"\u0000"}`,
	`{"type":"hello","nickname":"   "}`,
	`{"type":"hello","nickname":"\xff"}`,
	`{"type":"hello","nickname":7}`,
	`{"type":"chat","text":"oi\nlinha"}`,
	`{"type":"play","positionMs":1000,"rate":1}`,
	`{"type":"seek","positionMs":-1,"rate":1e308}`,
	`{"type":"rate","rate":0.1}`,
	`{"type":"ready","positionMs":5,"bufferAheadMs":9,"stalled":true}`,
	`{"type":"gating","enabled":false}`,
	`{"type":"subtitles","subtitles":{"track":-2}}`,
	`{"type":"titleRequest","title":{"metaId":"tt1","metaType":"movie"}}`,
	`{"type":"stageRequest","kind":"screen"}`,
	`{"type":"stageAnswer","requestId":"q1","allow":true}`,
	`{"type":"stageClose","kind":"screen","targetId":"m9"}`,
	`{"type":"spotlight","kind":"member","targetId":"m1"}`,
	`{"type":"spotlight"}`,
	`{"type":"kick","targetId":"m1"}`,
	`{"type":"transfer","targetId":"m1"}`,
	`{"type":"ignore","targetId":"m1"}`,
	`{"type":"source","origin":"youtube"}`,
	`{"type":"knock"}`,
	`{"type":"heartbeat","clientTimeMs":3}`,
	`[]`,
	`null`,
	`{"type":`,
}

func FuzzDecodeHello(f *testing.F) {
	for _, seed := range inboundSeeds {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		hello, ok := decodeHello(data)
		if !ok {
			return
		}
		require.Equal(t, "hello", hello.Type)
		require.True(t, validNickname(hello.Nickname), "%q", hello.Nickname)
		encoded, err := json.Marshal(hello)
		require.NoError(t, err)
		again, ok := decodeHello(encoded)
		require.True(t, ok, "an accepted hello must survive a round trip")
		require.Equal(t, hello.Nickname, again.Nickname)
	})
}

// FuzzRoomInbound feeds whatever decodes as an Inbound to a live room: no
// message may bring the room down, and the room must still answer a
// heartbeat after it. One socket carries every input, so the member is the
// room's controller and the fuzzer does not run the machine out of ports; a
// message that ends the socket (kicking oneself) must leave the room open to
// the next one.
func FuzzRoomInbound(f *testing.F) {
	for _, seed := range inboundSeeds {
		f.Add([]byte(seed))
	}
	previousRules, previousDefault := clientMessageRules, defaultMessageRule
	clientMessageRules, defaultMessageRule = nil, rateRule{burst: 1 << 20, every: time.Nanosecond}
	f.Cleanup(func() { clientMessageRules, defaultMessageRule = previousRules, previousDefault })
	_, _, server := newHubTestServer(f, config.Config{MaxParticipants: 1 << 16, RoomIdleSeconds: 3600})
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/rooms/r1"
	var member *websocket.Conn
	f.Cleanup(func() {
		if member != nil {
			_ = member.Close()
		}
	})
	var beat int64
	f.Fuzz(func(t *testing.T, data []byte) {
		var message Inbound
		if len(data) > maxWSMessageBytes || json.Unmarshal(data, &message) != nil || message.Type == "hello" {
			return
		}
		if member == nil {
			member = joinFuzzMember(t, wsURL)
		}
		beat++
		require.NoError(t, member.WriteMessage(websocket.TextMessage, data))
		require.NoError(t, member.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: beat}))
		for {
			require.NoError(t, member.SetReadDeadline(time.Now().Add(2*time.Second)))
			var event Outbound
			if err := member.ReadJSON(&event); err != nil {
				require.Equal(t, "kick", message.Type, "socket ended after %q: %v", data, err)
				_ = member.Close()
				member = joinFuzzMember(t, wsURL)
				return
			}
			if event.Type == "pong" && event.ClientTimeMs == beat {
				return
			}
		}
	})
}

// joinFuzzMember is dialHubWS and helloHubClient without t.Helper, which a
// fuzz target may not call on the F that owns the socket.
func joinFuzzMember(t *testing.T, wsURL string) *websocket.Conn {
	conn, response, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if response != nil {
		_ = response.Body.Close()
	}
	require.NoError(t, err)
	require.NoError(t, conn.WriteJSON(Inbound{Type: "hello", Nickname: "fuzz"}))
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(2*time.Second)))
	var welcome Outbound
	require.NoError(t, conn.ReadJSON(&welcome))
	require.Equal(t, "welcome", welcome.Type)
	return conn
}
