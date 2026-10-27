package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	stdsync "sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
)

type dmCall struct {
	Path string
	Auth string
	Body map[string]any
}

// fakeDMs is the bot's side of Discord: it opens DM channels and takes
// messages, or refuses them the way Discord does for closed DMs.
type fakeDMs struct {
	mu     stdsync.Mutex
	calls  []dmCall
	closed bool
}

func (f *fakeDMs) serve(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	record := func(r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		f.mu.Lock()
		f.calls = append(f.calls, dmCall{Path: r.URL.Path, Auth: r.Header.Get("Authorization"), Body: body})
		f.mu.Unlock()
	}
	mux.HandleFunc("POST /users/@me/channels", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		_, _ = w.Write([]byte(`{"id":"dm-1","type":1}`))
	})
	mux.HandleFunc("POST /channels/{id}/messages", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		f.mu.Lock()
		closed := f.closed
		f.mu.Unlock()
		if closed {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"Cannot send messages to this user","code":50007}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"msg-1"}`))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func (f *fakeDMs) snapshot() []dmCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]dmCall(nil), f.calls...)
}

func newInviteRig(t *testing.T, presence fixedPresence, dms *fakeDMs, botToken string) accountRig {
	t.Helper()
	_, rdb := newRedis(t)
	rooms := room.NewStore(rdb, 5*time.Hour)
	accounts := account.NewStore(rdb)
	cfg := config.Config{PublicOrigin: "https://juntos.test", DiscordBotToken: botToken,
		DiscordAPIBase: dms.serve(t).URL, RoomTTLHours: 5}
	router := gin.New()
	RegisterAccountRoutes(router.Group("/api"), cfg, accounts, rooms, presence)
	return accountRig{router: router, accounts: accounts, rooms: rooms}
}

func (rig accountRig) befriend(t *testing.T, a, b int64) {
	t.Helper()
	_, err := rig.accounts.RequestFriend(t.Context(), a, b)
	require.NoError(t, err)
	require.NoError(t, rig.accounts.AcceptFriend(t.Context(), b, a))
}

func (rig accountRig) openRoom(t *testing.T, id string, r room.Room) {
	t.Helper()
	now := time.Now()
	r.ID, r.Status, r.CreatedAt, r.ExpiresAt = id, room.StatusEmpty, now, now.Add(time.Hour)
	require.NoError(t, rig.rooms.Create(t.Context(), &r))
}

func TestInviteFriendSendsADM(t *testing.T) {
	dms := &fakeDMs{}
	rig := newInviteRig(t, fixedPresence{1: "LOCK1234"}, dms, "bot-token")
	rig.openRoom(t, "LOCK1234", room.Room{Name: "Noite *de* filme", FileName: "Duna.mkv"})
	require.NoError(t, rig.rooms.SetAccess(t.Context(), "LOCK1234", room.Access{Mode: room.JoinPassword, PasswordHash: "segredo-hash"}))
	ana, session := rig.signIn(t, "111", "Ana_[x](y)")
	bia, _ := rig.signIn(t, "80351110224678912", "Bia")
	rig.befriend(t, ana.ID, bia.ID)

	w := rig.do(http.MethodPost, "/api/friends/2/invite", "", session)

	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), "80351110224678912")
	calls := dms.snapshot()
	require.Len(t, calls, 2)
	require.Equal(t, "Bot bot-token", calls[0].Auth)
	require.Equal(t, map[string]any{"recipient_id": "80351110224678912"}, calls[0].Body)
	require.Equal(t, "/channels/dm-1/messages", calls[1].Path)
	message, err := json.Marshal(calls[1].Body)
	require.NoError(t, err)
	body := string(message)
	require.Contains(t, body, `"allowed_mentions":{"parse":[]}`)
	require.Contains(t, body, `"accent_color":16742981`)
	require.Contains(t, body, `https://juntos.lol/icon-512.png`)
	require.Contains(t, body, `Ana\\_\\[x\\]\\(y\\)`, "apelido escapado")
	require.Contains(t, body, `(#1) te chamou pra sala`)
	require.Contains(t, body, `Noite \\*de\\* filme`)
	require.Contains(t, body, `Duna\\.mkv`)
	require.Contains(t, body, `"url":"https://juntos.test/room/LOCK1234"`)
	require.Contains(t, body, `"label":"Entrar"`)
	require.NotContains(t, body, "segredo")
}

func TestInviteFriendRefusals(t *testing.T) {
	tests := []struct {
		name      string
		presence  fixedPresence
		botToken  string
		friends   bool
		closedDMs bool
		target    string
		want      int
		wantError string
	}{
		{name: "não-amigo", presence: fixedPresence{1: "OPEN1234"}, botToken: "bot", target: "2", want: http.StatusForbidden, wantError: "not_friends"},
		{name: "conta que não existe", presence: fixedPresence{1: "OPEN1234"}, botToken: "bot", target: "42", want: http.StatusForbidden, wantError: "not_friends"},
		{name: "fora de sala", presence: fixedPresence{}, botToken: "bot", friends: true, target: "2", want: http.StatusConflict, wantError: "not_in_room"},
		{name: "sala que já fechou", presence: fixedPresence{1: "GONE1234"}, botToken: "bot", friends: true, target: "2", want: http.StatusConflict, wantError: "not_in_room"},
		{name: "DM fechada", presence: fixedPresence{1: "OPEN1234"}, botToken: "bot", friends: true, closedDMs: true, target: "2", want: http.StatusConflict, wantError: "dm_closed"},
		{name: "sem bot", presence: fixedPresence{1: "OPEN1234"}, friends: true, target: "2", want: http.StatusServiceUnavailable, wantError: "invites_disabled"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dms := &fakeDMs{closed: tt.closedDMs}
			rig := newInviteRig(t, tt.presence, dms, tt.botToken)
			rig.openRoom(t, "OPEN1234", room.Room{})
			ana, session := rig.signIn(t, "111", "Ana")
			bia, _ := rig.signIn(t, "222", "Bia")
			if tt.friends {
				rig.befriend(t, ana.ID, bia.ID)
			}

			w := rig.do(http.MethodPost, "/api/friends/"+tt.target+"/invite", "", session)

			require.Equal(t, tt.want, w.Code, w.Body.String())
			require.JSONEq(t, `"`+tt.wantError+`"`, jsonField(t, w, "error"))
			require.NotContains(t, w.Body.String(), "222")
			if tt.closedDMs {
				require.JSONEq(t, `"OPEN1234"`, jsonField(t, w, "roomId"), "DM fechada devolve a sala para copiar o link")
			}
		})
	}
}

func TestFriendsSayWhoIsInMyRoom(t *testing.T) {
	rig := newInviteRig(t, fixedPresence{1: "LOCK1234", 2: "LOCK1234", 3: "OPEN1234"}, &fakeDMs{}, "bot")
	rig.openRoom(t, "LOCK1234", room.Room{})
	rig.openRoom(t, "OPEN1234", room.Room{})
	require.NoError(t, rig.rooms.SetAccess(t.Context(), "LOCK1234", room.Access{Mode: room.JoinPassword, PasswordHash: "x"}))
	ana, session := rig.signIn(t, "1", "Ana")
	bia, _ := rig.signIn(t, "2", "Bia")
	caio, _ := rig.signIn(t, "3", "Caio")
	dani, _ := rig.signIn(t, "4", "Dani")
	for _, friend := range []account.Account{bia, caio, dani} {
		rig.befriend(t, ana.ID, friend.ID)
	}

	friends := rig.do(http.MethodGet, "/api/friends", "", session)

	require.JSONEq(t, `[
		{"id":2,"nickname":"Bia","avatar":"","presence":{"inRoom":true,"withMe":true}},
		{"id":3,"nickname":"Caio","avatar":"","presence":{"inRoom":true,"roomId":"OPEN1234"}},
		{"id":4,"nickname":"Dani","avatar":"","presence":{"inRoom":false}}
	]`, jsonField(t, friends, "friends"))
}

func TestInviteNeedsSignIn(t *testing.T) {
	rig := newInviteRig(t, fixedPresence{}, &fakeDMs{}, "bot")
	require.Equal(t, http.StatusUnauthorized, rig.do(http.MethodPost, "/api/friends/2/invite", "").Code)
}

func TestInvitesAreRateLimited(t *testing.T) {
	dms := &fakeDMs{}
	rig := newInviteRig(t, fixedPresence{1: "OPEN1234"}, dms, "bot")
	rig.openRoom(t, "OPEN1234", room.Room{})
	ana, session := rig.signIn(t, "100", "Ana")
	for i := 1; i <= 5; i++ {
		friend, _ := rig.signIn(t, strconv.Itoa(200+i), "Amigo")
		rig.befriend(t, ana.ID, friend.ID)
	}
	invite := func(friend int64) int {
		return rig.do(http.MethodPost, "/api/friends/"+strconv.FormatInt(friend, 10)+"/invite", "", session).Code
	}

	for range invitesPerFriendPerHour {
		require.Equal(t, http.StatusNoContent, invite(2))
	}
	require.Equal(t, http.StatusTooManyRequests, invite(2), "o mesmo amigo só recebe alguns por hora")

	sent := invitesPerFriendPerHour
	for friend := int64(3); sent < invitesPerHour; friend++ {
		for i := 0; i < invitesPerFriendPerHour && sent < invitesPerHour; i++ {
			require.Equal(t, http.StatusNoContent, invite(friend))
			sent++
		}
	}
	require.Equal(t, http.StatusTooManyRequests, invite(6), "a conta inteira tem um teto por hora")
}
