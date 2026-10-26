package discord

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	stdsync "sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type apiCall struct {
	Method string
	Path   string
	Auth   string
	Body   map[string]any
}

type fakeDiscord struct {
	mu    stdsync.Mutex
	calls []apiCall
}

func (f *fakeDiscord) serve(t *testing.T) *httptest.Server {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		f.mu.Lock()
		f.calls = append(f.calls, apiCall{Method: r.Method, Path: r.URL.Path, Auth: r.Header.Get("Authorization"), Body: body})
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"msg-1"}`))
	}))
	t.Cleanup(server.Close)
	return server
}

func (f *fakeDiscord) snapshot() []apiCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]apiCall(nil), f.calls...)
}

type fakeCards struct {
	mu   stdsync.Mutex
	card Card
}

func (f *fakeCards) Card(context.Context, string) (Card, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.card, nil
}

func (f *fakeCards) set(card Card) {
	f.mu.Lock()
	f.card = card
	f.mu.Unlock()
}

func newNotifier(t *testing.T, link Link, botToken string, now *time.Time) (*Notifier, *fakeDiscord, *fakeCards, *LinkStore) {
	t.Helper()
	discord := &fakeDiscord{}
	server := discord.serve(t)
	links := newLinks(t)
	require.NoError(t, links.Put(t.Context(), "ROOM1234", link))
	cards := &fakeCards{card: Card{Members: []string{"Giuli"}}}
	notifier := &Notifier{
		API:      &API{Base: server.URL, AppID: "app-1", BotToken: botToken, Client: server.Client()},
		Links:    links,
		Cards:    cards,
		Origin:   "https://juntos.test",
		Debounce: 30 * time.Millisecond,
		Now:      func() time.Time { return *now },
	}
	return notifier, discord, cards, links
}

func waitCalls(t *testing.T, discord *fakeDiscord, n int) []apiCall {
	t.Helper()
	require.Eventually(t, func() bool { return len(discord.snapshot()) >= n }, 2*time.Second, 5*time.Millisecond)
	return discord.snapshot()
}

func TestCardGoesUpThroughTheBotWhenTheAppIsOnTheServer(t *testing.T) {
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	link := Link{ChannelID: "chan-1", InteractionToken: "tok", TokenExpiresAt: now.Add(15 * time.Minute), GuildInstalled: true, Name: "Sexta", Locked: true}
	notifier, discord, cards, links := newNotifier(t, link, "bot-token", &now)

	notifier.RoomChanged("ROOM1234")
	time.Sleep(60 * time.Millisecond)
	require.Empty(t, discord.snapshot(), "nothing is posted before the host is in")

	notifier.HostJoined("ROOM1234")
	calls := waitCalls(t, discord, 1)
	require.Equal(t, http.MethodPost, calls[0].Method)
	require.Equal(t, "/channels/chan-1/messages", calls[0].Path)
	require.Equal(t, "Bot bot-token", calls[0].Auth)
	embed := calls[0].Body["embeds"].([]any)[0].(map[string]any)
	require.Contains(t, embed["title"], "Sexta")
	require.Contains(t, embed["title"], "🔒")
	buttons := calls[0].Body["components"].([]any)[0].(map[string]any)["components"].([]any)
	require.Equal(t, "https://juntos.test/room/ROOM1234", buttons[0].(map[string]any)["url"])
	require.Equal(t, "copy:ROOM1234", buttons[1].(map[string]any)["custom_id"])

	stored, err := links.Get(t.Context(), "ROOM1234")
	require.NoError(t, err)
	require.Equal(t, "msg-1", stored.MessageID)
	require.True(t, stored.ViaBot)

	// A burst of changes is one edit, a debounce later.
	cards.set(Card{Members: []string{"Giuli", "Ana"}, Playing: "filme.mkv"})
	notifier.RoomChanged("ROOM1234")
	notifier.RoomChanged("ROOM1234")
	notifier.RoomChanged("ROOM1234")
	calls = waitCalls(t, discord, 2)
	time.Sleep(60 * time.Millisecond)
	require.Len(t, discord.snapshot(), 2)
	require.Equal(t, http.MethodPatch, calls[1].Method)
	require.Equal(t, "/channels/chan-1/messages/msg-1", calls[1].Path)
	require.Contains(t, mustJSON(t, calls[1].Body), "Ana")
	require.Contains(t, mustJSON(t, calls[1].Body), "filme.mkv")

	// A second HostJoined (the host reloading) does not post a second card.
	notifier.HostJoined("ROOM1234")
	time.Sleep(60 * time.Millisecond)
	require.Len(t, discord.snapshot(), 2)

	notifier.RoomClosed("ROOM1234")
	calls = waitCalls(t, discord, 3)
	require.Equal(t, http.MethodPatch, calls[2].Method)
	require.Contains(t, mustJSON(t, calls[2].Body), "encerrada")
	require.Empty(t, calls[2].Body["components"], "a closed room has no buttons")
	_, err = links.Get(t.Context(), "ROOM1234")
	require.ErrorIs(t, err, ErrNoLink)
}

func TestCardUsesTheInteractionTokenWithoutABotAndFreezesAfterIt(t *testing.T) {
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	link := Link{ChannelID: "chan-1", InteractionToken: "tok", TokenExpiresAt: now.Add(15 * time.Minute)}
	notifier, discord, _, _ := newNotifier(t, link, "", &now)

	notifier.HostJoined("ROOM1234")
	calls := waitCalls(t, discord, 1)
	require.Equal(t, http.MethodPost, calls[0].Method)
	require.Equal(t, "/webhooks/app-1/tok", calls[0].Path)
	require.Empty(t, calls[0].Auth)

	notifier.RoomChanged("ROOM1234")
	calls = waitCalls(t, discord, 2)
	require.Equal(t, http.MethodPatch, calls[1].Method)
	require.Equal(t, "/webhooks/app-1/tok/messages/msg-1", calls[1].Path)

	now = now.Add(16 * time.Minute)
	notifier.RoomChanged("ROOM1234")
	notifier.RoomClosed("ROOM1234")
	time.Sleep(100 * time.Millisecond)
	require.Len(t, discord.snapshot(), 2, "past the token's life the card stays as it was")
}

func TestCardIgnoresRoomsFromElsewhere(t *testing.T) {
	now := time.Now()
	notifier, discord, _, _ := newNotifier(t, Link{ChannelID: "c"}, "bot", &now)
	notifier.HostJoined("OTHER")
	notifier.RoomClosed("OTHER")
	time.Sleep(60 * time.Millisecond)
	require.Empty(t, discord.snapshot())
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	require.NoError(t, err)
	return string(raw)
}
