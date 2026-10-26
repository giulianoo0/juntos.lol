package sync

import (
	"errors"
	"net"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
)

func TestRateLimiterSpendsTheBurstThenRefills(t *testing.T) {
	start := time.Unix(1_000, 0)
	limiter := newRateLimiter(map[string]rateRule{"chat": {burst: 3, every: time.Second}}, rateRule{burst: 100, every: time.Millisecond})

	for range 3 {
		require.True(t, limiter.allow("chat", start).ok)
	}
	denied := limiter.allow("chat", start)
	require.False(t, denied.ok)
	require.True(t, denied.first, "the first refusal is the one worth telling the client about")
	require.False(t, limiter.allow("chat", start).first, "later refusals in the same run stay quiet")

	require.True(t, limiter.allow("chat", start.Add(time.Second)).ok, "a token comes back each interval")
	require.False(t, limiter.allow("chat", start.Add(time.Second)).ok)

	require.True(t, limiter.allow("chat", start.Add(time.Hour)).ok)
	for range 2 {
		require.True(t, limiter.allow("chat", start.Add(time.Hour)).ok, "the bucket never holds more than its burst")
	}
	require.True(t, limiter.allow("chat", start.Add(time.Hour)).first)
}

func TestRateLimiterKeepsABucketPerType(t *testing.T) {
	start := time.Unix(1_000, 0)
	limiter := newRateLimiter(map[string]rateRule{"stageRequest": {burst: 1, every: time.Minute}}, rateRule{burst: 2, every: time.Minute})

	require.True(t, limiter.allow("stageRequest", start).ok)
	require.False(t, limiter.allow("stageRequest", start).ok)
	require.True(t, limiter.allow("seek", start).ok, "a spent type leaves the others alone")
	require.True(t, limiter.allow("play", start).ok, "unlisted types get a bucket each from the default rule")
	require.True(t, limiter.allow("play", start).ok)
	require.False(t, limiter.allow("play", start).ok)
}

func TestRateLimiterBoundsTheBucketsAClientCanOpen(t *testing.T) {
	start := time.Unix(1_000, 0)
	limiter := newRateLimiter(nil, rateRule{burst: 1, every: time.Minute})
	for i := range maxRateBuckets {
		require.True(t, limiter.allow(string(rune('a'+i%26))+string(rune('a'+i/26)), start).ok)
	}
	require.False(t, limiter.allow("one-type-too-many", start).ok, "made-up types cannot grow the map forever")
}

func TestClientMessageRulesNameTheNoisyTypes(t *testing.T) {
	for _, kind := range []string{"chat", "stageRequest", "knock"} {
		rule, ok := clientMessageRules[kind]
		require.True(t, ok, kind)
		require.Less(t, rule.burst, defaultMessageRule.burst, kind)
		require.Greater(t, rule.every, defaultMessageRule.every, kind)
	}
}

func TestHubDropsAChatFloodAndSaysSoOnce(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	host := dialHubWS(t, server)
	helloHubClient(t, host, "host", 1)
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 2)
	require.Equal(t, "members", readHubEvent(t, host).Type)

	burst := clientMessageRules["chat"].burst
	for range burst + 5 {
		require.NoError(t, guest.WriteJSON(Inbound{Type: "chat", Text: "spam"}))
	}
	require.NoError(t, guest.WriteJSON(Inbound{Type: "heartbeat", ClientTimeMs: 7}))

	chats, limited := 0, 0
	for {
		event := readHubEvent(t, guest)
		if event.Type == "pong" {
			break
		}
		switch {
		case event.Type == "chat":
			chats++
		case event.Type == "error" && event.ErrCode == "rate_limited":
			limited++
		}
	}
	require.Equal(t, burst, chats)
	require.Equal(t, 1, limited)
}

func TestHubClosesASocketThatSendsAnOversizedMessage(t *testing.T) {
	_, _, server := newHubTestServer(t, config.Config{MaxParticipants: 20, RoomIdleSeconds: 10})
	guest := dialHubWS(t, server)
	helloHubClient(t, guest, "guest", 1)
	big := make([]byte, maxWSMessageBytes+1)
	for i := range big {
		big[i] = 'a'
	}
	require.NoError(t, guest.WriteMessage(websocket.TextMessage, append(append([]byte(`{"type":"chat","text":"`), big...), '"', '}')))
	require.NoError(t, guest.SetReadDeadline(time.Now().Add(3*time.Second)))
	for {
		if _, _, err := guest.ReadMessage(); err != nil {
			var netErr net.Error
			require.False(t, errors.As(err, &netErr) && netErr.Timeout(), "the server must hang up, not wait")
			return
		}
	}
}
