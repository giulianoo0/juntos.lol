package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/db/dbtest"
	"github.com/giulianoo0/ss/internal/room"
)

type fixedPresence map[int64]string

func (p fixedPresence) Presence(ids []int64) map[int64]string {
	present := map[int64]string{}
	for _, id := range ids {
		if roomID, ok := p[id]; ok {
			present[id] = roomID
		}
	}
	return present
}

// fakeDiscord answers the code exchange and /users/@me for one user.
func fakeDiscord(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /oauth2/token", func(w http.ResponseWriter, r *http.Request) {
		require.NoError(t, r.ParseForm())
		if r.Form.Get("code") != "good-code" || r.Form.Get("client_secret") != "secret" {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"user-token","token_type":"Bearer"}`))
	})
	mux.HandleFunc("GET /users/@me", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer user-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"id":"80351110224678912","username":"ana","global_name":"Ana"}`))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

type accountRig struct {
	router   *gin.Engine
	accounts *account.Store
	rooms    *room.Store
}

func newAccountRig(t *testing.T, presence fixedPresence) accountRig {
	t.Helper()
	_, rdb := newRedis(t)
	rooms := room.NewStore(rdb, 5*time.Hour)
	accounts := account.NewStore(dbtest.New(t))
	cfg := config.Config{
		PublicOrigin: "https://juntos.test", DiscordClientID: "client", DiscordClientSecret: "secret",
		DiscordAPIBase: fakeDiscord(t).URL,
	}
	router := gin.New()
	RegisterAccountRoutes(router.Group("/api"), cfg, accounts, rooms, presence)
	return accountRig{router: router, accounts: accounts, rooms: rooms}
}

// signIn opens an account and a session for it, the way the callback would,
// showing its history to friends so the visibility rules have someone to show.
func (rig accountRig) signIn(t *testing.T, discordID, name string) (account.Account, *http.Cookie) {
	t.Helper()
	created, err := rig.accounts.SignInDiscord(t.Context(), account.DiscordUser{ID: discordID, GlobalName: name})
	require.NoError(t, err)
	friends := account.VisibilityFriends
	created, err = rig.accounts.Update(t.Context(), created.ID, account.Changes{Visibility: &friends})
	require.NoError(t, err)
	token, err := rig.accounts.StartSession(t.Context(), created.ID)
	require.NoError(t, err)
	return created, &http.Cookie{Name: accountCookie, Value: token}
}

func (rig accountRig) do(method, path, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}
	rig.router.ServeHTTP(w, req)
	return w
}

func cookieNamed(w *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	return nil
}

func TestDiscordLogin(t *testing.T) {
	tests := []struct {
		name string
		next string
		want string
	}{
		{name: "sem next volta para o início", next: "", want: "/"},
		{name: "caminho relativo é respeitado", next: "/r/ABCD1234?x=1", want: "/r/ABCD1234?x=1"},
		{name: "url absoluta é barrada", next: "https://evil.test/", want: "/"},
		{name: "url sem esquema é barrada", next: "//evil.test/", want: "/"},
		{name: "barra invertida é barrada", next: "/\\evil.test", want: "/"},
		{name: "javascript é barrado", next: "javascript:alert(1)", want: "/"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rig := newAccountRig(t, nil)

			start := rig.do(http.MethodGet, "/api/auth/discord?next="+url.QueryEscape(tt.next), "")
			require.Equal(t, http.StatusFound, start.Code)
			authorize, err := url.Parse(start.Header().Get("Location"))
			require.NoError(t, err)
			require.Equal(t, "discord.com", authorize.Host)
			require.Equal(t, "identify", authorize.Query().Get("scope"))
			require.Equal(t, "https://juntos.test/api/auth/discord/callback", authorize.Query().Get("redirect_uri"))
			state := authorize.Query().Get("state")
			require.NotEmpty(t, state)
			stateCookie := cookieNamed(start, oauthStateCookie)
			require.NotNil(t, stateCookie)

			back := rig.do(http.MethodGet, "/api/auth/discord/callback?code=good-code&state="+url.QueryEscape(state), "", stateCookie)

			require.Equal(t, http.StatusFound, back.Code)
			require.Equal(t, tt.want, back.Header().Get("Location"))
			session := cookieNamed(back, accountCookie)
			require.NotNil(t, session)
			require.True(t, session.HttpOnly)
			require.True(t, session.Secure)
			require.Equal(t, http.SameSiteLaxMode, session.SameSite)
			me := rig.do(http.MethodGet, "/api/me", "", session)
			require.Equal(t, http.StatusOK, me.Code)
			require.JSONEq(t, `"Ana"`, jsonField(t, me, "nickname"))
			require.NotContains(t, me.Body.String(), "80351110224678912", "o id do Discord não sai do servidor")
		})
	}
}

func TestDiscordLoginJoinsTheServerWithItsRole(t *testing.T) {
	discord := fakeDiscord(t)
	joined := make(chan string, 4)
	discord.Config.Handler.(*http.ServeMux).HandleFunc("PUT /guilds/{guild}/members/{user}", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			AccessToken string   `json:"access_token"`
			Roles       []string `json:"roles"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		joined <- r.Header.Get("Authorization") + " " + r.PathValue("guild") + " " + r.PathValue("user") + " " + body.AccessToken + " " + strings.Join(body.Roles, ",")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{}`))
	})
	discord.Config.Handler.(*http.ServeMux).HandleFunc("PUT /guilds/{guild}/members/{user}/roles/{role}", func(w http.ResponseWriter, r *http.Request) {
		joined <- "role " + r.PathValue("role")
		w.WriteHeader(http.StatusNoContent)
	})
	_, rdb := newRedis(t)
	cfg := config.Config{
		PublicOrigin: "https://juntos.test", DiscordClientID: "client", DiscordClientSecret: "secret",
		DiscordAPIBase: discord.URL, DiscordBotToken: "bot-token", DiscordGuildID: "G1", DiscordMemberRoleID: "R1",
	}
	router := gin.New()
	RegisterAccountRoutes(router.Group("/api"), cfg, account.NewStore(dbtest.New(t)), room.NewStore(rdb, 5*time.Hour), nil)
	rig := accountRig{router: router}

	start := rig.do(http.MethodGet, "/api/auth/discord", "")
	authorize, err := url.Parse(start.Header().Get("Location"))
	require.NoError(t, err)
	require.Equal(t, "identify guilds.join", authorize.Query().Get("scope"))
	back := rig.do(http.MethodGet, "/api/auth/discord/callback?code=good-code&state="+url.QueryEscape(authorize.Query().Get("state")), "",
		cookieNamed(start, oauthStateCookie))
	require.Equal(t, http.StatusFound, back.Code)

	require.Equal(t, "Bot bot-token G1 80351110224678912 user-token R1", <-joined)
	require.Equal(t, "role R1", <-joined, "quem já estava no servidor também ganha o cargo")
}

func TestDiscordCallbackRefusesABadState(t *testing.T) {
	tests := []struct {
		name   string
		state  string
		cookie *http.Cookie
	}{
		{name: "sem cookie de state", state: "abc"},
		{name: "state diferente do cookie", state: "abc", cookie: &http.Cookie{Name: oauthStateCookie, Value: "xyz"}},
		{name: "state vazio", state: "", cookie: &http.Cookie{Name: oauthStateCookie, Value: ""}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rig := newAccountRig(t, nil)
			cookies := []*http.Cookie{}
			if tt.cookie != nil {
				cookies = append(cookies, tt.cookie)
			}

			w := rig.do(http.MethodGet, "/api/auth/discord/callback?code=good-code&state="+tt.state, "", cookies...)

			require.Equal(t, http.StatusBadRequest, w.Code)
			require.Nil(t, cookieNamed(w, accountCookie))
			_, err := rig.accounts.Get(t.Context(), 1)
			require.ErrorIs(t, err, account.ErrNotFound, "nenhuma conta nasce de um state forjado")
		})
	}
}

func TestDiscordLoginIsOffWithoutASecret(t *testing.T) {
	_, rdb := newRedis(t)
	router := gin.New()
	RegisterAccountRoutes(router.Group("/api"), config.Config{DiscordClientID: "client", PublicOrigin: "https://juntos.test"},
		account.NewStore(nil), room.NewStore(rdb, time.Hour), nil)

	for _, path := range []string{"/api/auth/discord", "/api/auth/discord/callback?code=x&state=y"} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, http.StatusServiceUnavailable, w.Code, path)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/me", nil))
	require.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestLogoutEndsTheSession(t *testing.T) {
	rig := newAccountRig(t, nil)
	_, session := rig.signIn(t, "1", "Ana")

	require.Equal(t, http.StatusNoContent, rig.do(http.MethodPost, "/api/auth/logout", "", session).Code)

	require.Equal(t, http.StatusUnauthorized, rig.do(http.MethodGet, "/api/me", "", session).Code)
}

func TestPatchMe(t *testing.T) {
	rig := newAccountRig(t, nil)
	_, session := rig.signIn(t, "1", "Ana")

	w := rig.do(http.MethodPatch, "/api/me", `{"nickname":"Aninha","avatar":"fox.bowtie"}`, session)
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `"fox.bowtie"`, jsonField(t, w, "avatar"))

	require.Equal(t, http.StatusBadRequest, rig.do(http.MethodPatch, "/api/me", `{"avatar":"../x"}`, session).Code)
	require.Equal(t, http.StatusUnauthorized, rig.do(http.MethodPatch, "/api/me", `{"nickname":"x"}`).Code)
}

func TestFriendsSeeWhereTheOthersAre(t *testing.T) {
	rig := newAccountRig(t, fixedPresence{2: "OPEN1234", 3: "LOCK1234"})
	now := time.Now()
	for _, id := range []string{"OPEN1234", "LOCK1234"} {
		require.NoError(t, rig.rooms.Create(t.Context(), &room.Room{ID: id, Status: room.StatusEmpty, CreatedAt: now, ExpiresAt: now.Add(time.Hour)}))
	}
	require.NoError(t, rig.rooms.SetAccess(t.Context(), "LOCK1234", room.Access{Mode: room.JoinPassword, PasswordHash: "x"}))
	_, anaSession := rig.signIn(t, "1", "Ana")
	_, biaSession := rig.signIn(t, "2", "Bia")
	_, caioSession := rig.signIn(t, "3", "Caio")

	require.Equal(t, http.StatusOK, rig.do(http.MethodPost, "/api/friends/requests", `{"id":2}`, anaSession).Code)
	require.Equal(t, http.StatusOK, rig.do(http.MethodPost, "/api/friends/requests", `{"id":3}`, anaSession).Code)
	requests := rig.do(http.MethodGet, "/api/friends/requests", "", biaSession)
	require.JSONEq(t, `[{"id":1,"nickname":"Ana","avatar":""}]`, jsonField(t, requests, "incoming"))
	require.Equal(t, http.StatusNoContent, rig.do(http.MethodPost, "/api/friends/requests/1/accept", "", biaSession).Code)
	require.Equal(t, http.StatusNoContent, rig.do(http.MethodPost, "/api/friends/requests/1/accept", "", caioSession).Code)
	require.Equal(t, http.StatusNotFound, rig.do(http.MethodPost, "/api/friends/requests/1/accept", "", caioSession).Code,
		"aceitar duas vezes não acha pedido")

	friends := rig.do(http.MethodGet, "/api/friends", "", anaSession)
	require.Equal(t, http.StatusOK, friends.Code)
	require.JSONEq(t, `[
		{"id":2,"nickname":"Bia","avatar":"","presence":{"inRoom":true,"roomId":"OPEN1234"}},
		{"id":3,"nickname":"Caio","avatar":"","presence":{"inRoom":true}}
	]`, jsonField(t, friends, "friends"), "sala trancada só diz que está em sala")

	require.Equal(t, http.StatusNoContent, rig.do(http.MethodDelete, "/api/friends/2", "", anaSession).Code)
	friends = rig.do(http.MethodGet, "/api/friends", "", biaSession)
	require.JSONEq(t, `[]`, jsonField(t, friends, "friends"))
}

func TestFriendRequestsAreRateLimited(t *testing.T) {
	rig := newAccountRig(t, nil)
	_, session := rig.signIn(t, "1", "Ana")
	limited := false
	for i := 0; i < friendRequestsPerHour+1; i++ {
		w := rig.do(http.MethodPost, "/api/friends/requests", `{"id":99}`, session)
		if w.Code == http.StatusTooManyRequests {
			limited = true
		}
	}
	require.True(t, limited)
}

func TestHistoryFollowsVisibility(t *testing.T) {
	type viewer int
	const (
		self viewer = iota
		friend
		stranger
		anonymous
	)
	tests := []struct {
		visibility string
		viewer     viewer
		visible    bool
		// Bia keeps the friends-only visibility, so she shows among
		// who was there only to whoever may see her own history.
		seesBia bool
	}{
		{account.VisibilityPublic, anonymous, true, false},
		{account.VisibilityPublic, stranger, true, false},
		{account.VisibilityFriends, friend, true, true},
		{account.VisibilityFriends, stranger, false, false},
		{account.VisibilityFriends, anonymous, false, false},
		{account.VisibilityPrivate, friend, false, false},
		{account.VisibilityPrivate, self, true, true},
	}
	for _, tt := range tests {
		name := tt.visibility + "/" + map[viewer]string{self: "a própria conta", friend: "amigo", stranger: "estranho", anonymous: "anônimo"}[tt.viewer]
		t.Run(name, func(t *testing.T) {
			rig := newAccountRig(t, nil)
			owner, ownerSession := rig.signIn(t, "1", "Ana")
			bia, biaSession := rig.signIn(t, "2", "Bia")
			_, caioSession := rig.signIn(t, "3", "Caio")
			_, err := rig.accounts.RequestFriend(t.Context(), owner.ID, bia.ID)
			require.NoError(t, err)
			require.NoError(t, rig.accounts.AcceptFriend(t.Context(), bia.ID, owner.ID))
			require.NoError(t, rig.accounts.RecordWatch(t.Context(), owner.ID, account.Watch{
				RoomID: "OPEN1234", Title: "Filme", Kind: "file", StartedAt: time.Now(), DurationSec: 7200, With: []int64{bia.ID},
			}))
			visibility := tt.visibility
			_, err = rig.accounts.Update(t.Context(), owner.ID, account.Changes{Visibility: &visibility})
			require.NoError(t, err)
			cookies := map[viewer][]*http.Cookie{self: {ownerSession}, friend: {biaSession}, stranger: {caioSession}}[tt.viewer]

			history := rig.do(http.MethodGet, "/api/users/1/history", "", cookies...)
			profile := rig.do(http.MethodGet, "/api/users/1", "", cookies...)

			if !tt.visible && tt.visibility == account.VisibilityPrivate {
				// A conta existe: dizer "ninguém com esse número" mentia para quem
				// abria /c/5. Diz que é privada, sem apelido nem avatar.
				require.Equal(t, http.StatusForbidden, profile.Code)
				require.JSONEq(t, `{"error":"account_private"}`, profile.Body.String())
				require.Equal(t, http.StatusForbidden, history.Code)
				require.JSONEq(t, `{"error":"account_private"}`, history.Body.String())
				return
			}
			require.Equal(t, http.StatusOK, profile.Code)
			if !tt.visible {
				require.Equal(t, http.StatusForbidden, history.Code)
				require.JSONEq(t, `{"id":1,"nickname":"Ana","avatar":""}`, profile.Body.String(),
					"perfil fechado não mostra nada além de número, apelido e avatar")
				return
			}
			require.Equal(t, http.StatusOK, history.Code)
			require.Contains(t, history.Body.String(), `"Filme"`)
			if tt.seesBia {
				require.Contains(t, history.Body.String(), `"nickname":"Bia"`)
			} else {
				require.NotContains(t, history.Body.String(), `"Bia"`, "companhia que não se mostra fica de fora")
			}
			require.JSONEq(t, `{"sessions":1,"hours":2,"friends":1}`, jsonField(t, profile, "stats"))
		})
	}
}

func TestUnknownUserIsNotFound(t *testing.T) {
	rig := newAccountRig(t, nil)
	require.Equal(t, http.StatusNotFound, rig.do(http.MethodGet, "/api/users/42", "").Code)
	require.Equal(t, http.StatusNotFound, rig.do(http.MethodGet, "/api/users/abc", "").Code)
}

func jsonField(t *testing.T, w *httptest.ResponseRecorder, field string) string {
	t.Helper()
	var body map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body), w.Body.String())
	return string(body[field])
}
