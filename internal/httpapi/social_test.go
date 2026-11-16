package httpapi

import (
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/db/dbtest"
	"github.com/giulianoo0/ss/internal/discord"
	"github.com/giulianoo0/ss/internal/dm"
	"github.com/giulianoo0/ss/internal/room"
)

type socialRig struct {
	accountRig
	social *Social
	server *httptest.Server
}

func newSocialRig(t *testing.T, presence fixedPresence) socialRig {
	t.Helper()
	_, rdb := newRedis(t)
	pool := dbtest.New(t)
	accounts := account.NewStore(pool)
	cfg := config.Config{PublicOrigin: "https://juntos.test", DiscordClientID: "client", DiscordClientSecret: "secret",
		DiscordAPIBase: fakeDiscord(t).URL}
	social := NewSocial(cfg, accounts, dm.NewStore(pool))
	router := gin.New()
	rooms := room.NewStore(rdb, 5*time.Hour)
	routes := RegisterAccountRoutes(router.Group("/api"), cfg, accounts, rooms, presence)
	routes.social = social
	social.register(router, routes.viewer)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return socialRig{accountRig: accountRig{router: router, accounts: accounts, rooms: rooms}, social: social, server: server}
}

func (rig socialRig) device(t *testing.T, session *http.Cookie) dm.Device {
	t.Helper()
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	require.NoError(t, err)
	body := fmt.Sprintf(`{"publicKey":%q}`, base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()))
	w := rig.do(http.MethodPost, "/api/dm/devices", body, session)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var device dm.Device
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &device))
	return device
}

func (rig socialRig) inbox(t *testing.T, session *http.Cookie, device string) *websocket.Conn {
	t.Helper()
	header := http.Header{"Cookie": {session.String()}, "Origin": {"https://juntos.test"}}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(rig.server.URL, "http")+"/ws/inbox?device="+device, header)
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })
	require.Equal(t, "hello", readEvent(t, conn).Type)
	return conn
}

func readEvent(t *testing.T, conn *websocket.Conn) inboxEvent {
	t.Helper()
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(3*time.Second)))
	for {
		var event inboxEvent
		require.NoError(t, conn.ReadJSON(&event))
		if event.Type != "presence" {
			return event
		}
	}
}

func b64n(n int) string {
	raw := make([]byte, n)
	_, _ = rand.Read(raw)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func sealedFor(devices ...dm.Device) string {
	keys := map[string]dm.WrappedKey{}
	for _, d := range devices {
		keys[d.ID] = dm.WrappedKey{IV: b64n(12), Key: b64n(48)}
	}
	raw, _ := json.Marshal(keys)
	return string(raw)
}

func TestPrivateMessageReachesEachDeviceWithItsOwnKey(t *testing.T) {
	rig := newSocialRig(t, nil)
	ana, anaSession := rig.signIn(t, "1", "Ana")
	bia, biaSession := rig.signIn(t, "2", "Bia")
	rig.befriendBoth(t, ana, bia, anaSession, biaSession)
	anaDevice := rig.device(t, anaSession)
	biaDevice := rig.device(t, biaSession)
	biaInbox := rig.inbox(t, biaSession, biaDevice.ID)
	require.Eventually(t, func() bool { return rig.social.Online(bia.ID) }, time.Second, 10*time.Millisecond)

	body := fmt.Sprintf(`{"senderDevice":%q,"clientId":"cli-00001","iv":%q,"body":%q,"keys":%s}`,
		anaDevice.ID, b64n(12), b64n(40), sealedFor(anaDevice, biaDevice))
	sent := rig.do(http.MethodPost, fmt.Sprintf("/api/dm/with/%d", bia.ID), body, anaSession)
	require.Equal(t, http.StatusOK, sent.Code, sent.Body.String())

	event := readEvent(t, biaInbox)
	require.Equal(t, "dm", event.Type)
	require.Equal(t, ana.ID, event.Message.From)
	require.NotNil(t, event.Message.Key, "o aparelho da Bia recebe a chave dele")

	page := rig.do(http.MethodGet, fmt.Sprintf("/api/dm/with/%d?device=%s", ana.ID, biaDevice.ID), "", biaSession)
	require.Equal(t, http.StatusOK, page.Code)
	var got struct {
		Messages []dm.Message `json:"messages"`
	}
	require.NoError(t, json.Unmarshal(page.Body.Bytes(), &got))
	require.Len(t, got.Messages, 1)

	read := rig.do(http.MethodPost, fmt.Sprintf("/api/dm/with/%d/read", ana.ID), fmt.Sprintf(`{"upTo":%d}`, got.Messages[0].ID), biaSession)
	require.Equal(t, http.StatusNoContent, read.Code)
}

func TestMessageWrappedForTooFewDevicesComesBackWithTheCurrentOnes(t *testing.T) {
	rig := newSocialRig(t, nil)
	ana, anaSession := rig.signIn(t, "1", "Ana")
	bia, biaSession := rig.signIn(t, "2", "Bia")
	rig.befriendBoth(t, ana, bia, anaSession, biaSession)
	anaDevice := rig.device(t, anaSession)
	rig.device(t, biaSession)

	body := fmt.Sprintf(`{"senderDevice":%q,"clientId":"cli-00002","iv":%q,"body":%q,"keys":%s}`,
		anaDevice.ID, b64n(12), b64n(40), sealedFor(anaDevice))
	w := rig.do(http.MethodPost, fmt.Sprintf("/api/dm/with/%d", bia.ID), body, anaSession)
	require.Equal(t, http.StatusConflict, w.Code)
	require.Equal(t, `"stale_devices"`, jsonField(t, w, "error"))
	var theirs []dm.Device
	require.NoError(t, json.Unmarshal([]byte(jsonField(t, w, "theirs")), &theirs))
	require.Len(t, theirs, 1)
}

func TestOnlyFriendsTalkAndSeeTheDiscordPicture(t *testing.T) {
	cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("png:" + r.URL.Path))
	}))
	defer cdn.Close()
	rig := newSocialRig(t, nil)
	rig.social.CDN = cdn.URL
	ana, anaSession := rig.signIn(t, "1", "Ana")
	bia, biaSession := rig.signIn(t, "2", "Bia")
	anaDevice := rig.device(t, anaSession)

	body := fmt.Sprintf(`{"senderDevice":%q,"clientId":"cli-00003","iv":%q,"body":%q,"keys":%s}`,
		anaDevice.ID, b64n(12), b64n(40), sealedFor(anaDevice))
	require.Equal(t, http.StatusForbidden, rig.do(http.MethodPost, fmt.Sprintf("/api/dm/with/%d", bia.ID), body, anaSession).Code)
	require.Equal(t, http.StatusNotFound, rig.do(http.MethodGet, fmt.Sprintf("/api/users/%d/discord-avatar", bia.ID), "", anaSession).Code)

	rig.befriendBoth(t, ana, bia, anaSession, biaSession)
	require.NoError(t, rig.accounts.SetDiscordAvatar(t.Context(), bia.ID, strings.Repeat("ab", 16)))
	picture := rig.do(http.MethodGet, fmt.Sprintf("/api/users/%d/discord-avatar", bia.ID), "", anaSession)
	require.Equal(t, http.StatusOK, picture.Code)
	require.Equal(t, "png:/avatars/2/"+strings.Repeat("ab", 16)+".png", picture.Body.String())
}

func TestFriendsSeeWhoHasJuntosOpenAndTheirDiscordStatus(t *testing.T) {
	rig := newSocialRig(t, nil)
	presences := &discord.Presences{GuildID: "g"}
	rig.social.SetDiscord(presences)
	ana, anaSession := rig.signIn(t, "1", "Ana")
	bia, biaSession := rig.signIn(t, "2", "Bia")
	rig.befriendBoth(t, ana, bia, anaSession, biaSession)
	anaInbox := rig.inbox(t, anaSession, "")

	rig.inbox(t, biaSession, "")
	require.Equal(t, "presence", readRaw(t, anaInbox), "a Ana fica sabendo que a Bia abriu o juntos")
	friends := rig.do(http.MethodGet, "/api/friends", "", anaSession)
	require.JSONEq(t, `[{"id":2,"nickname":"Bia","avatar":"","presence":{"online":true,"discord":"offline","inRoom":false}}]`, jsonField(t, friends, "friends"))
}

func readRaw(t *testing.T, conn *websocket.Conn) string {
	t.Helper()
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(3*time.Second)))
	var event inboxEvent
	require.NoError(t, conn.ReadJSON(&event))
	return event.Type
}

func (rig socialRig) befriendBoth(t *testing.T, a, b account.Account, aSession, bSession *http.Cookie) {
	t.Helper()
	require.Equal(t, http.StatusOK, rig.do(http.MethodPost, "/api/friends/requests", fmt.Sprintf(`{"id":%d}`, b.ID), aSession).Code)
	require.Equal(t, http.StatusNoContent, rig.do(http.MethodPost, fmt.Sprintf("/api/friends/requests/%d/accept", a.ID), "", bSession).Code)
}

func TestDesktopLoginWaitsForTheBrowserToSayYesToTheSameCode(t *testing.T) {
	rig := newSocialRig(t, nil)
	_, session := rig.signIn(t, "1", "Ana")
	verifier := strings.Repeat("v", 50)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	poll := func() int {
		return rig.do(http.MethodPost, "/api/auth/app/poll", fmt.Sprintf(`{"verifier":%q}`, verifier)).Code
	}

	page := rig.do(http.MethodGet, "/api/auth/app?poll=1&challenge="+challenge, "", session)
	require.Equal(t, http.StatusOK, page.Code)
	require.Contains(t, page.Body.String(), PairingCode(challenge))
	require.Equal(t, http.StatusAccepted, poll(), "abrir o link sozinho não entra")

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/app/confirm", strings.NewReader(url.Values{"challenge": {challenge}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(session)
	rig.router.ServeHTTP(w, req)
	require.Equal(t, http.StatusSeeOther, w.Code)

	w = rig.do(http.MethodPost, "/api/auth/app/poll", fmt.Sprintf(`{"verifier":%q}`, verifier))
	require.Equal(t, http.StatusNoContent, w.Code)
	require.NotNil(t, cookieNamed(w, accountCookie))
	require.Equal(t, http.StatusAccepted, poll(), "a sessão sai uma vez só")
}

func TestConfirmingFromAnotherSiteIsRefused(t *testing.T) {
	rig := newSocialRig(t, nil)
	_, session := rig.signIn(t, "1", "Ana")
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/app/confirm", strings.NewReader("challenge="+strings.Repeat("a", 43)))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "https://evil.test")
	req.AddCookie(session)
	rig.router.ServeHTTP(w, req)
	require.Equal(t, http.StatusForbidden, w.Code)
}
