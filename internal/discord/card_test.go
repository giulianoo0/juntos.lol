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
	require.InDelta(t, flagComponentsV2, calls[0].Body["flags"], 0)
	require.NotContains(t, calls[0].Body, "embeds", "a new webhook message with components V2 refuses embeds")
	require.Contains(t, mustJSON(t, calls[0].Body), "Sexta")
	require.Contains(t, mustJSON(t, calls[0].Body), "🔒 Senha")

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
	require.Contains(t, mustJSON(t, calls[1].Body), `filme\\.mkv`)
	require.Nil(t, calls[1].Body["content"], "the edit clears an old card's content")
	require.Equal(t, []any{}, calls[1].Body["embeds"], "the bot's edit clears an old card's embed")

	// A second HostJoined (the host reloading) does not post a second card.
	notifier.HostJoined("ROOM1234")
	time.Sleep(60 * time.Millisecond)
	require.Len(t, discord.snapshot(), 2)

	notifier.RoomClosed("ROOM1234")
	calls = waitCalls(t, discord, 3)
	require.Equal(t, http.MethodPatch, calls[2].Method)
	require.Contains(t, mustJSON(t, calls[2].Body), "encerrada")
	require.NotContains(t, mustJSON(t, calls[2].Body), "custom_id", "a closed room has no buttons")
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
	require.Contains(t, calls[1].Body, "embeds")
	require.Nil(t, calls[1].Body["embeds"], "the webhook edit clears an old card's embed with null")

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

func TestRoomCard(t *testing.T) {
	const logo = "https://juntos.test/icon-512.png"
	tests := []struct {
		name  string
		link  Link
		card  Card
		types []float64
		texts []string
		thumb []string
	}{
		{
			name:  "sala vazia mostra nome, porta aberta, logo e contagem",
			card:  Card{Name: "Sexta", Door: DoorOpen, Members: []string{"Giuli"}},
			types: []float64{componentSection, componentSeparator, componentText, componentRow},
			texts: []string{"## Sexta", "🔓 Aberta", "👥 **1** · Giuli"},
			thumb: []string{logo},
		},
		{
			name:  "o que está tocando ganha a capa ao lado",
			card:  Card{Door: DoorApproval, Members: []string{"Giuli", "Ana"}, Playing: "Lofi ao vivo", Image: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"},
			types: []float64{componentSection, componentSeparator, componentSection, componentText, componentRow},
			texts: []string{"## Sala", "✋ Aprovação", "▶️ **Lofi ao vivo**", "👥 **2** · Giuli, Ana"},
			thumb: []string{logo, "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"},
		},
		{
			name:  "sem capa o que está tocando é só texto",
			link:  Link{Name: "Do comando", Locked: true},
			card:  Card{Playing: "filme.mkv"},
			types: []float64{componentSection, componentSeparator, componentText, componentText, componentRow},
			texts: []string{"## Do comando", "🔒 Senha", `▶️ **filme\.mkv**`, "👥 **0**"},
			thumb: []string{logo},
		},
		{
			name:  "nove pessoas listam oito e contam a última",
			card:  Card{Name: "Cheia", Door: DoorOpen, Members: []string{"a", "b", "c", "d", "e", "f", "g", "h", "i"}},
			types: []float64{componentSection, componentSeparator, componentText, componentRow},
			texts: []string{"## Cheia", "🔓 Aberta", "👥 **9** · a, b, c, d, e, f, g, h e mais 1"},
			thumb: []string{logo},
		},
		{
			name:  "apelido e nome com markdown aparecem como foram digitados",
			card:  Card{Name: "**Sexta**\n# oi", Door: DoorOpen, Members: []string{"[x](https://evil.test)", "@everyone", "<@123>"}},
			types: []float64{componentSection, componentSeparator, componentText, componentRow},
			texts: []string{`## \*\*Sexta\*\* \# oi`, "🔓 Aberta", `👥 **3** · \[x\]\(https\:\/\/evil\.test\), \@everyone, \<\@123\>`},
			thumb: []string{logo},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require := require.New(t)
			notifier := &Notifier{Origin: "https://juntos.test"}
			var message map[string]any
			require.NoError(json.Unmarshal([]byte(mustJSON(t, notifier.roomCard("ROOM1234", &tt.link, tt.card))), &message))

			require.InDelta(1<<15, message["flags"], 0)
			require.Equal(map[string]any{"parse": []any{}}, message["allowed_mentions"])
			require.NotContains(message, "content")
			require.NotContains(message, "embeds")
			top := message["components"].([]any)
			require.Len(top, 1)
			container := top[0].(map[string]any)
			require.InDelta(componentContainer, container["type"], 0)
			require.InDelta(0xFF7A45, container["accent_color"], 0)

			var types []float64
			var texts, thumbs []string
			var buttons []any
			for _, raw := range container["components"].([]any) {
				part := raw.(map[string]any)
				types = append(types, part["type"].(float64))
				switch part["type"].(float64) {
				case componentText:
					texts = append(texts, part["content"].(string))
				case componentSection:
					for _, child := range part["components"].([]any) {
						texts = append(texts, child.(map[string]any)["content"].(string))
					}
					accessory := part["accessory"].(map[string]any)
					require.InDelta(componentThumbnail, accessory["type"], 0)
					thumbs = append(thumbs, accessory["media"].(map[string]any)["url"].(string))
				case componentRow:
					buttons = part["components"].([]any)
				}
			}
			require.Equal(tt.types, types)
			require.Equal(tt.texts, texts)
			require.Equal(tt.thumb, thumbs)
			require.Len(buttons, 2)
			require.Equal(map[string]any{"type": float64(componentButton), "style": float64(buttonLink), "label": "Entrar", "url": "https://juntos.test/room/ROOM1234"}, buttons[0])
			require.Equal(map[string]any{"type": float64(componentButton), "style": float64(buttonSecondary), "label": "Copiar link", "custom_id": "copy:ROOM1234"}, buttons[1])
		})
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	require.NoError(t, err)
	return string(raw)
}
