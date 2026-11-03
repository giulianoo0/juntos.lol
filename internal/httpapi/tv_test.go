package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/db/dbtest"
	"github.com/giulianoo0/ss/internal/tv"
)

// tvRooms seats each account in the rooms listed for it and cuts
// recognizable tickets.
type tvRooms map[int64][]string

func (r tvRooms) Seated(accountID int64, roomID string) bool {
	return slices.Contains(r[accountID], roomID)
}

func (tvRooms) MintTicket(roomID string) string { return "ticket-" + roomID }

type tvRig struct {
	router   *gin.Engine
	server   *httptest.Server
	accounts *account.Store
	access   TVAccess
}

func newTVRig(t *testing.T, seats tvRooms) tvRig {
	t.Helper()
	_, rdb := newRedis(t)
	pool := dbtest.New(t)
	accounts := account.NewStore(pool)
	access := TVAccess{Devices: tv.NewDevices(pool), Pairs: tv.NewPairs(rdb), Mixes: tv.NewMixes(rdb)}
	router := gin.New()
	RegisterTVRoutes(router, config.Config{PublicOrigin: "https://juntos.test"}, accounts, access, seats)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return tvRig{router: router, server: server, accounts: accounts, access: access}
}

func (rig tvRig) signIn(t *testing.T, discordID, name string) (account.Account, *http.Cookie) {
	t.Helper()
	created, err := rig.accounts.SignInDiscord(t.Context(), account.DiscordUser{ID: discordID, GlobalName: name})
	require.NoError(t, err)
	token, err := rig.accounts.StartSession(t.Context(), created.ID)
	require.NoError(t, err)
	return created, &http.Cookie{Name: accountCookie, Value: token}
}

func (rig tvRig) do(method, path, body string, header http.Header, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for key, values := range header {
		req.Header[key] = values
	}
	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}
	rig.router.ServeHTTP(w, req)
	return w
}

// linkTV pairs a TV to the account behind cookie and returns its device id and token.
func (rig tvRig) linkTV(t *testing.T, cookie *http.Cookie) (string, string) {
	t.Helper()
	device, token, err := rig.access.Devices.Create(t.Context(), mustSessionAccount(t, rig, cookie), "Sala")
	require.NoError(t, err)
	return device.ID, token
}

func mustSessionAccount(t *testing.T, rig tvRig, cookie *http.Cookie) int64 {
	t.Helper()
	id, err := rig.accounts.SessionAccount(t.Context(), cookie.Value)
	require.NoError(t, err)
	return id
}

func (rig tvRig) dialTV(t *testing.T, token string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	serverURL, err := url.Parse(rig.server.URL)
	require.NoError(t, err)
	serverURL.Scheme = "ws"
	serverURL.Path = "/ws/tv"
	serverURL.RawQuery = url.Values{"token": {token}}.Encode()
	conn, response, err := websocket.DefaultDialer.Dial(serverURL.String(), nil)
	if conn != nil {
		t.Cleanup(func() { _ = conn.Close() })
	}
	return conn, response, err
}

// openTV connects the TV and reads the mix it is greeted with.
func (rig tvRig) openTV(t *testing.T, token string) *websocket.Conn {
	t.Helper()
	conn, response, err := rig.dialTV(t, token)
	require.NoError(t, err)
	response.Body.Close()
	greeting := readTV(t, conn)
	require.Equal(t, "mix", greeting["type"])
	return conn
}

func readTV(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(2*time.Second)))
	var message map[string]any
	require.NoError(t, conn.ReadJSON(&message))
	return message
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body), w.Body.String())
	return body
}

func TestTVPairingHandsTheTokenOverOnce(t *testing.T) {
	rig := newTVRig(t, nil)
	ana, cookie := rig.signIn(t, "111", "Ana")

	started := rig.do(http.MethodPost, "/api/tv/pair", "", nil)
	require.Equal(t, http.StatusOK, started.Code)
	pair := decode(t, started)
	code, pairID := pair["code"].(string), pair["pairId"].(string)
	require.Regexp(t, `^[A-Z0-9]{8}$`, code)
	require.NotEmpty(t, pair["expiresAt"])

	pending := rig.do(http.MethodGet, "/api/tv/pair/"+pairID, "", nil)
	require.Equal(t, http.StatusOK, pending.Code)
	require.Equal(t, "pending", decode(t, pending)["status"])

	typed := strings.ToLower(code[:4] + "-" + code[4:])
	linked := rig.do(http.MethodPost, "/api/tv/link", `{"code":"`+typed+`"}`, nil, cookie)
	require.Equal(t, http.StatusOK, linked.Code, linked.Body.String())
	device := decode(t, linked)["device"].(map[string]any)
	require.NotEmpty(t, device["id"])

	handed := rig.do(http.MethodGet, "/api/tv/pair/"+pairID, "", nil)
	require.Equal(t, http.StatusOK, handed.Code)
	body := decode(t, handed)
	require.Equal(t, "linked", body["status"])
	require.Equal(t, device["id"], body["device"].(map[string]any)["id"])
	require.Equal(t, "Ana", body["account"].(map[string]any)["nickname"])
	token := body["token"].(string)
	require.NotEmpty(t, token)

	require.Equal(t, http.StatusNotFound, rig.do(http.MethodGet, "/api/tv/pair/"+pairID, "", nil).Code, "o token sai uma vez só")

	me := rig.do(http.MethodGet, "/api/tv/me", "", http.Header{"Authorization": {"Bearer " + token}})
	require.Equal(t, http.StatusOK, me.Code)
	meBody := decode(t, me)
	require.Equal(t, device["id"], meBody["device"].(map[string]any)["id"])
	require.Equal(t, float64(ana.ID), meBody["account"].(map[string]any)["id"])
}

func TestTVLinkRefusesAnUnknownCodeOrNoAccount(t *testing.T) {
	rig := newTVRig(t, nil)
	_, cookie := rig.signIn(t, "111", "Ana")

	unknown := rig.do(http.MethodPost, "/api/tv/link", `{"code":"ABCD-EFGH"}`, nil, cookie)
	require.Equal(t, http.StatusNotFound, unknown.Code)
	require.Equal(t, "code_not_found", decode(t, unknown)["error"])

	code := decode(t, rig.do(http.MethodPost, "/api/tv/pair", "", nil))["code"].(string)
	require.Equal(t, http.StatusUnauthorized, rig.do(http.MethodPost, "/api/tv/link", `{"code":"`+code+`"}`, nil).Code)
	foreign := rig.do(http.MethodPost, "/api/tv/link", `{"code":"`+code+`"}`, http.Header{"Origin": {"https://evil.test"}}, cookie)
	require.Equal(t, http.StatusForbidden, foreign.Code, "vincular só a partir do site")
}

func TestTVPairIsLimitedPerAddress(t *testing.T) {
	rig := newTVRig(t, nil)
	for range tvPairsPerHour {
		require.Equal(t, http.StatusOK, rig.do(http.MethodPost, "/api/tv/pair", "", nil).Code)
	}

	refused := rig.do(http.MethodPost, "/api/tv/pair", "", nil)

	require.Equal(t, http.StatusTooManyRequests, refused.Code)
}

func TestTVMeRefusesARevokedToken(t *testing.T) {
	rig := newTVRig(t, nil)
	_, cookie := rig.signIn(t, "111", "Ana")
	deviceID, token := rig.linkTV(t, cookie)
	bearer := http.Header{"Authorization": {"Bearer " + token}}
	require.Equal(t, http.StatusOK, rig.do(http.MethodGet, "/api/tv/me", "", bearer).Code)

	require.Equal(t, http.StatusNoContent, rig.do(http.MethodDelete, "/api/tv/devices/"+deviceID, "", nil, cookie).Code)

	require.Equal(t, http.StatusUnauthorized, rig.do(http.MethodGet, "/api/tv/me", "", bearer).Code)
	_, response, err := rig.dialTV(t, token)
	require.Error(t, err)
	require.Equal(t, http.StatusUnauthorized, response.StatusCode)
}

func TestTVUnlinkDropsItsSocket(t *testing.T) {
	rig := newTVRig(t, nil)
	_, cookie := rig.signIn(t, "111", "Ana")
	deviceID, token := rig.linkTV(t, cookie)
	conn := rig.openTV(t, token)

	require.Equal(t, http.StatusNoContent, rig.do(http.MethodDelete, "/api/tv/devices/"+deviceID, "", nil, cookie).Code)

	require.Equal(t, "revoked", readTV(t, conn)["type"])
	_, _, err := conn.ReadMessage()
	require.Error(t, err, "e o socket fecha")
}

func TestTVCastNeedsTheAccountInTheRoomAndTheTVOnline(t *testing.T) {
	seats := tvRooms{}
	rig := newTVRig(t, seats)
	ana, cookie := rig.signIn(t, "111", "Ana")
	seats[ana.ID] = []string{"EARLIER1", "ROOM1234"}
	deviceID, token := rig.linkTV(t, cookie)
	cast := func(roomID string) *httptest.ResponseRecorder {
		return rig.do(http.MethodPost, "/api/tv/devices/"+deviceID+"/cast", `{"roomId":"`+roomID+`"}`, nil, cookie)
	}

	elsewhere := cast("OTHER123")
	require.Equal(t, http.StatusConflict, elsewhere.Code)
	require.Equal(t, "not_in_room", decode(t, elsewhere)["error"])
	offline := cast("ROOM1234")
	require.Equal(t, http.StatusConflict, offline.Code)
	require.Equal(t, "tv_offline", decode(t, offline)["error"])

	conn := rig.openTV(t, token)
	require.Equal(t, http.StatusNoContent, cast("ROOM1234").Code)

	pushed := readTV(t, conn)
	require.Equal(t, map[string]any{"type": "cast", "roomId": "ROOM1234", "ticket": "ticket-ROOM1234"}, pushed)
	require.Equal(t, http.StatusNoContent, rig.do(http.MethodPost, "/api/tv/devices/"+deviceID+"/stop", "", nil, cookie).Code)
	require.Equal(t, "stop", readTV(t, conn)["type"])
}

func TestTVDevicesBelongToTheirAccount(t *testing.T) {
	rig := newTVRig(t, nil)
	_, ana := rig.signIn(t, "111", "Ana")
	_, bia := rig.signIn(t, "222", "Bia")
	deviceID, _ := rig.linkTV(t, ana)

	for _, call := range []struct{ method, path, body string }{
		{http.MethodPatch, "/api/tv/devices/" + deviceID, `{"name":"Minha"}`},
		{http.MethodDelete, "/api/tv/devices/" + deviceID, ""},
		{http.MethodPost, "/api/tv/devices/" + deviceID + "/cast", `{"roomId":"ROOM1234"}`},
		{http.MethodPost, "/api/tv/devices/" + deviceID + "/stop", ""},
		{http.MethodPut, "/api/tv/devices/" + deviceID + "/mix", `{"media":1,"people":{}}`},
	} {
		t.Run(call.method+" "+call.path, func(t *testing.T) {
			w := rig.do(call.method, call.path, call.body, nil, bia)
			require.Equal(t, http.StatusNotFound, w.Code)
			require.Equal(t, "device_not_found", decode(t, w)["error"])
		})
	}
	listed := decode(t, rig.do(http.MethodGet, "/api/tv/devices", "", nil, bia))["devices"].([]any)
	require.Empty(t, listed)
}

func TestTVRename(t *testing.T) {
	rig := newTVRig(t, nil)
	_, cookie := rig.signIn(t, "111", "Ana")
	deviceID, _ := rig.linkTV(t, cookie)

	renamed := rig.do(http.MethodPatch, "/api/tv/devices/"+deviceID, `{"name":"TV do quarto"}`, nil, cookie)
	require.Equal(t, http.StatusOK, renamed.Code)
	require.Equal(t, "TV do quarto", decode(t, renamed)["device"].(map[string]any)["name"])
	require.Equal(t, http.StatusBadRequest, rig.do(http.MethodPatch, "/api/tv/devices/"+deviceID, `{"name":""}`, nil, cookie).Code)
}

func TestTVDevicesShowWhatTheTVIsDoing(t *testing.T) {
	rig := newTVRig(t, nil)
	_, cookie := rig.signIn(t, "111", "Ana")
	_, token := rig.linkTV(t, cookie)
	device := func() map[string]any {
		listed := decode(t, rig.do(http.MethodGet, "/api/tv/devices", "", nil, cookie))["devices"].([]any)
		require.Len(t, listed, 1)
		return listed[0].(map[string]any)
	}
	offline := device()
	require.Equal(t, false, offline["online"])
	require.NotContains(t, offline, "roomId")
	require.Equal(t, map[string]any{"media": 1.0, "people": map[string]any{}}, offline["mix"])

	conn := rig.openTV(t, token)
	require.NoError(t, conn.WriteJSON(map[string]any{"type": "state", "roomId": "ROOM1234"}))
	require.NoError(t, conn.WriteJSON(map[string]any{"type": "mix", "mix": map[string]any{"media": 0.5, "people": map[string]any{"m1": 0}}}))

	require.Eventually(t, func() bool {
		seen := device()
		mix, _ := seen["mix"].(map[string]any)
		return seen["online"] == true && seen["roomId"] == "ROOM1234" && mix["media"] == 0.5
	}, 2*time.Second, 20*time.Millisecond)
	require.NoError(t, conn.WriteJSON(map[string]any{"type": "state", "roomId": nil}))
	require.Eventually(t, func() bool { _, in := device()["roomId"]; return !in }, 2*time.Second, 20*time.Millisecond)

	require.NoError(t, conn.Close())
	require.Eventually(t, func() bool { return device()["online"] == false }, 2*time.Second, 20*time.Millisecond)
}

func TestTVMixFromThePhoneReachesTheTV(t *testing.T) {
	rig := newTVRig(t, nil)
	_, cookie := rig.signIn(t, "111", "Ana")
	deviceID, token := rig.linkTV(t, cookie)
	conn := rig.openTV(t, token)

	saved := rig.do(http.MethodPut, "/api/tv/devices/"+deviceID+"/mix", `{"media":0.2,"people":{"m3":0}}`, nil, cookie)
	require.Equal(t, http.StatusOK, saved.Code)

	pushed := readTV(t, conn)
	require.Equal(t, "mix", pushed["type"])
	require.Equal(t, map[string]any{"media": 0.2, "people": map[string]any{"m3": 0.0}}, pushed["mix"])
	invalid := rig.do(http.MethodPut, "/api/tv/devices/"+deviceID+"/mix", `{"media":2,"people":{}}`, nil, cookie)
	require.Equal(t, http.StatusBadRequest, invalid.Code)
	require.Equal(t, "invalid_mix", decode(t, invalid)["error"])
}

func TestTVSkipsTheHumanCheckOnlyWithAValidToken(t *testing.T) {
	rig := newTVRig(t, nil)
	_, cookie := rig.signIn(t, "111", "Ana")
	_, token := rig.linkTV(t, cookie)
	gate := NewHumanGate(config.Config{TurnstileSiteKey: "site", TurnstileSecret: "s3cret"})
	router := gin.New()
	router.GET("/ws/rooms/:id", TVOrHuman(rig.access.Devices, gate.Require()), func(c *gin.Context) { c.Status(http.StatusNoContent) })
	open := func(query string) int {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/ws/rooms/ROOM1234"+query, nil))
		return w.Code
	}

	require.Equal(t, http.StatusNoContent, open("?tv="+url.QueryEscape(token)))
	require.Equal(t, http.StatusForbidden, open("?tv=forjado"))
	require.Equal(t, http.StatusForbidden, open(""))
}

func TestHubIdentifiesATVAsItsAccount(t *testing.T) {
	rig := newTVRig(t, nil)
	ana, cookie := rig.signIn(t, "111", "Ana")
	deviceID, token := rig.linkTV(t, cookie)
	accounts := HubAccounts(rig.accounts, rig.access.Devices)
	identify := func(query string) (bool, bool, int64) {
		identity, ok := accounts.Identify(httptest.NewRequest(http.MethodGet, "/ws/rooms/ROOM1234"+query, nil))
		return ok, identity.TV, identity.AccountID
	}

	ok, isTV, id := identify("?tv=" + url.QueryEscape(token))
	require.True(t, ok)
	require.True(t, isTV)
	require.Equal(t, ana.ID, id)

	require.NoError(t, rig.access.Devices.Delete(t.Context(), ana.ID, deviceID))
	ok, _, _ = identify("?tv=" + url.QueryEscape(token))
	require.False(t, ok, "token revogado não identifica ninguém")
}
