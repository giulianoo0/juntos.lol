package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/discord"
	"github.com/giulianoo0/ss/internal/room"
)

func TestFriendRequestDMsTheAskedOnce(t *testing.T) {
	dms := &fakeDMs{}
	rig := newInviteRig(t, nil, dms, "bot-token")
	_, anaSession := rig.signIn(t, "111", "Ana")
	rig.signIn(t, "80351110224678912", "Bia")

	require.Equal(t, http.StatusOK, rig.do(http.MethodPost, "/api/friends/requests", `{"id":2}`, anaSession).Code)
	require.Eventually(t, func() bool { return len(dms.snapshot()) == 2 }, time.Second, 5*time.Millisecond)
	require.Equal(t, http.StatusOK, rig.do(http.MethodPost, "/api/friends/requests", `{"id":2}`, anaSession).Code)
	time.Sleep(50 * time.Millisecond)

	calls := dms.snapshot()
	require.Len(t, calls, 2, "pedir de novo não manda outra DM")
	require.Equal(t, map[string]any{"recipient_id": "80351110224678912"}, calls[0].Body)
	message, err := json.Marshal(calls[1].Body)
	require.NoError(t, err)
	require.Contains(t, string(message), `"custom_id":"friend:accept:1:2"`)
	require.Contains(t, string(message), `"custom_id":"friend:decline:1:2"`)
	require.Contains(t, string(message), `"url":"https://juntos.test/c/1"`)
}

func TestNotificationsListRequestsAndOpenInvites(t *testing.T) {
	dms := &fakeDMs{}
	rig := newInviteRig(t, fixedPresence{1: "OPEN1234", 2: "GONE1234"}, dms, "bot-token")
	rig.openRoom(t, "OPEN1234", room.Room{Name: "Sexta"})
	ana, anaSession := rig.signIn(t, "1", "Ana")
	bia, _ := rig.signIn(t, "2", "Bia")
	caio, caioSession := rig.signIn(t, "3", "Caio")
	rig.befriend(t, ana.ID, caio.ID)
	rig.befriend(t, bia.ID, caio.ID)
	require.Equal(t, http.StatusOK, rig.do(http.MethodPost, "/api/friends/requests", `{"id":3}`, rig.session(t, 4, "Dani")).Code)

	require.Equal(t, http.StatusNoContent, rig.do(http.MethodPost, "/api/friends/3/invite", "", anaSession).Code)
	// Bia's room is gone by the time Caio looks.
	require.NoError(t, rig.accounts.AddInvite(t.Context(), caio.ID, account.RoomInvite{From: bia.ID, RoomID: "GONE1234", At: time.Now()}))

	got := rig.do(http.MethodGet, "/api/notifications", "", caioSession)

	require.Equal(t, http.StatusOK, got.Code, got.Body.String())
	require.JSONEq(t, `[{"id":4,"nickname":"Dani","avatar":""}]`, jsonField(t, got, "friendRequests"))
	var invites []pendingInvite
	require.NoError(t, json.Unmarshal([]byte(jsonField(t, got, "invites")), &invites))
	require.Len(t, invites, 1, "convite de sala que acabou some")
	require.Equal(t, "OPEN1234", invites[0].RoomID)
	require.Equal(t, "Sexta", invites[0].RoomName)
	require.Equal(t, accountCard{ID: 1, Nickname: "Ana"}, invites[0].From)

	require.Equal(t, http.StatusNoContent, rig.do(http.MethodDelete, "/api/invites/1", "", caioSession).Code)
	got = rig.do(http.MethodGet, "/api/notifications", "", caioSession)
	require.JSONEq(t, `[]`, jsonField(t, got, "invites"))
	require.Equal(t, http.StatusUnauthorized, rig.do(http.MethodGet, "/api/notifications", "").Code)
}

func TestNotificationsLeaveOutTheRoomImIn(t *testing.T) {
	rig := newInviteRig(t, fixedPresence{1: "OPEN1234", 2: "OPEN1234"}, &fakeDMs{}, "bot-token")
	rig.openRoom(t, "OPEN1234", room.Room{})
	ana, anaSession := rig.signIn(t, "1", "Ana")
	bia, biaSession := rig.signIn(t, "2", "Bia")
	rig.befriend(t, ana.ID, bia.ID)
	require.Equal(t, http.StatusNoContent, rig.do(http.MethodPost, "/api/friends/2/invite", "", anaSession).Code)

	got := rig.do(http.MethodGet, "/api/notifications", "", biaSession)

	require.JSONEq(t, `[]`, jsonField(t, got, "invites"))
}

func TestDiscordNameFollowsItsOwnVisibility(t *testing.T) {
	rig := newAccountRig(t, nil)
	ana, err := rig.accounts.SignInDiscord(t.Context(), account.DiscordUser{ID: "1", Username: "ana.x", GlobalName: "Ana"})
	require.NoError(t, err)
	public := account.VisibilityPublic
	_, err = rig.accounts.Update(t.Context(), ana.ID, account.Changes{Visibility: &public})
	require.NoError(t, err)
	anaSession := rig.session(t, ana.ID, "")
	_, caioSession := rig.signIn(t, "3", "Caio")

	me := rig.do(http.MethodGet, "/api/me", "", anaSession)
	require.JSONEq(t, `{"username":"ana.x","globalName":"Ana"}`, jsonField(t, me, "discord"))
	require.JSONEq(t, `"private"`, jsonField(t, me, "discordVisibility"))
	require.JSONEq(t, `{"username":"ana.x","globalName":"Ana"}`, jsonField(t, rig.do(http.MethodGet, "/api/users/1", "", anaSession), "discord"),
		"a dona vê o próprio Discord")
	require.NotContains(t, rig.do(http.MethodGet, "/api/users/1", "", caioSession).Body.String(), "ana.x")
	require.NotContains(t, rig.do(http.MethodGet, "/api/users/1", "").Body.String(), "ana.x")

	require.Equal(t, http.StatusOK, rig.do(http.MethodPatch, "/api/me", `{"discordVisibility":"public"}`, anaSession).Code)
	require.Contains(t, rig.do(http.MethodGet, "/api/users/1", "").Body.String(), `"username":"ana.x"`)
	require.Equal(t, http.StatusBadRequest, rig.do(http.MethodPatch, "/api/me", `{"discordVisibility":"friends"}`, anaSession).Code)
}

func TestDiscordFriendsAnswerOnlyForTheAsked(t *testing.T) {
	rig := newAccountRig(t, nil)
	ana, _ := rig.signIn(t, "ana-discord", "Ana")
	bia, _ := rig.signIn(t, "bia-discord", "Bia")
	rig.signIn(t, "caio-discord", "Caio")
	friends := DiscordFriends(rig.accounts)
	ctx := t.Context()
	_, err := rig.accounts.RequestFriend(ctx, ana.ID, bia.ID)
	require.NoError(t, err)

	_, err = friends.AnswerFriend(ctx, "caio-discord", bia.ID, ana.ID, true)
	require.ErrorIs(t, err, discord.ErrNotYours, "outra conta não aceita pela Bia")
	_, err = friends.AnswerFriend(ctx, "caio-discord", 3, ana.ID, true)
	require.NoError(t, err, "trocar o destino no custom_id só responde o próprio pedido (que não existe)")
	_, err = friends.AnswerFriend(ctx, "stranger-discord", bia.ID, ana.ID, true)
	require.ErrorIs(t, err, discord.ErrNotYours)
	areFriends, _ := rig.accounts.AreFriends(ctx, ana.ID, bia.ID)
	require.False(t, areFriends)

	answer, err := friends.AnswerFriend(ctx, "bia-discord", bia.ID, ana.ID, true)
	require.NoError(t, err)
	require.Equal(t, discord.FriendAnswer{Outcome: discord.FriendAccepted, From: "Ana", Number: ana.ID}, answer)
	areFriends, _ = rig.accounts.AreFriends(ctx, ana.ID, bia.ID)
	require.True(t, areFriends)

	answer, err = friends.AnswerFriend(ctx, "bia-discord", bia.ID, ana.ID, false)
	require.NoError(t, err)
	require.Equal(t, discord.FriendAlready, answer.Outcome, "recusar depois de aceito não desfaz")

	_, err = rig.accounts.RequestFriend(ctx, 3, bia.ID)
	require.NoError(t, err)
	answer, err = friends.AnswerFriend(ctx, "bia-discord", bia.ID, 3, false)
	require.NoError(t, err)
	require.Equal(t, discord.FriendDeclined, answer.Outcome)
	answer, err = friends.AnswerFriend(ctx, "bia-discord", bia.ID, 3, true)
	require.NoError(t, err)
	require.Equal(t, discord.FriendGone, answer.Outcome)
}

// session signs in account `id`, opening it first when a name is given.
func (rig accountRig) session(t *testing.T, id int64, name string) *http.Cookie {
	t.Helper()
	if name != "" {
		created, cookie := rig.signIn(t, "discord-"+name, name)
		require.Equal(t, id, created.ID)
		return cookie
	}
	token, err := rig.accounts.StartSession(t.Context(), id)
	require.NoError(t, err)
	return &http.Cookie{Name: accountCookie, Value: token}
}
