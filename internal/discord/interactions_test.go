package discord

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

type fakeRooms struct{ got []NewRoom }

func (f *fakeRooms) CreateRoom(_ context.Context, request NewRoom) (CreatedRoom, error) {
	f.got = append(f.got, request)
	return CreatedRoom{ID: "ROOM1234", OwnerToken: "owner-secret"}, nil
}

func newLinks(t *testing.T) *LinkStore {
	t.Helper()
	mr := miniredis.RunT(t)
	return NewLinkStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}))
}

func signed(t *testing.T, key ed25519.PrivateKey, body string) *http.Request {
	t.Helper()
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	signature := ed25519.Sign(key, []byte(timestamp+body))
	request := httptest.NewRequest(http.MethodPost, "/api/discord/interactions", bytes.NewBufferString(body))
	request.Header.Set("X-Signature-Ed25519", hex.EncodeToString(signature))
	request.Header.Set("X-Signature-Timestamp", timestamp)
	return request
}

func newHandler(t *testing.T) (*Handler, ed25519.PrivateKey, *fakeRooms, *LinkStore) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	rooms := &fakeRooms{}
	links := newLinks(t)
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	return &Handler{PublicKey: public, Rooms: rooms, Links: links, Origin: "https://juntos.test", Now: func() time.Time { return now }}, private, rooms, links
}

func TestInteractionsRefuseUnsignedCalls(t *testing.T) {
	handler, _, _, _ := newHandler(t)
	_, stranger, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)

	w := httptest.NewRecorder()
	handler.ServeHTTP(w, signed(t, stranger, `{"type":1}`))
	require.Equal(t, http.StatusUnauthorized, w.Code)

	w = httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/discord/interactions", bytes.NewBufferString(`{"type":1}`))
	handler.ServeHTTP(w, request)
	require.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestInteractionsAnswerPing(t *testing.T) {
	handler, key, _, _ := newHandler(t)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, signed(t, key, `{"type":1}`))
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"type":1}`, w.Body.String())
}

const newCommand = `{
  "type": 2,
  "token": "interaction-token",
  "channel_id": "chan-1",
  "guild_id": "guild-1",
  "authorizing_integration_owners": {"0": "guild-1", "1": "user-1"},
  "member": {"user": {"id": "user-1", "username": "giuli", "global_name": "Giuli"}},
  "data": {"name": "juntos", "options": [{"type": 1, "name": "new", "options": [
    {"type": 3, "name": "nome", "value": "Sessão de sexta"},
    {"type": 3, "name": "senha", "value": "pipoca"}
  ]}]}
}`

func TestJuntosNewCreatesTheRoomAndAnswersOnlyTheHost(t *testing.T) {
	handler, key, rooms, links := newHandler(t)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, signed(t, key, newCommand))
	require.Equal(t, http.StatusOK, w.Code)

	require.Equal(t, []NewRoom{{Nickname: "Giuli", Name: "Sessão de sexta", Password: "pipoca"}}, rooms.got)

	var response struct {
		Type int `json:"type"`
		Data struct {
			Flags      int `json:"flags"`
			Components []struct {
				Type       int `json:"type"`
				Components []struct {
					Type  int    `json:"type"`
					Style int    `json:"style"`
					Label string `json:"label"`
					URL   string `json:"url"`
				} `json:"components"`
			} `json:"components"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
	require.Equal(t, 4, response.Type)
	require.Equal(t, 64, response.Data.Flags, "only the one who ran the command sees the host link")
	button := response.Data.Components[0].Components[0]
	require.Equal(t, 2, button.Type)
	require.Equal(t, 5, button.Style)
	require.Equal(t, "Entrar como host", button.Label)
	require.Equal(t, "https://juntos.test/room/ROOM1234#owner=owner-secret", button.URL)

	link, err := links.Get(t.Context(), "ROOM1234")
	require.NoError(t, err)
	require.Equal(t, Link{
		ChannelID: "chan-1", GuildID: "guild-1", InteractionToken: "interaction-token",
		TokenExpiresAt: handler.Now().Add(interactionTokenLife), GuildInstalled: true,
		Name: "Sessão de sexta", Locked: true,
	}, *link)
}

func TestJuntosNewFromAUserInstall(t *testing.T) {
	handler, key, rooms, links := newHandler(t)
	body := `{"type":2,"token":"tok","channel_id":"dm-1","authorizing_integration_owners":{"1":"user-1"},
	  "user":{"id":"user-1","username":"giuli"},"data":{"name":"juntos","options":[{"type":1,"name":"new"}]}}`
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, signed(t, key, body))
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []NewRoom{{Nickname: "giuli"}}, rooms.got)
	link, err := links.Get(t.Context(), "ROOM1234")
	require.NoError(t, err)
	require.False(t, link.GuildInstalled)
	require.False(t, link.Locked)
}

func TestCopyLinkButtonAnswersWithTheLink(t *testing.T) {
	handler, key, _, _ := newHandler(t)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, signed(t, key, `{"type":3,"data":{"custom_id":"copy:ROOM1234"}}`))
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"type":4,"data":{"flags":64,"content":"https://juntos.test/room/ROOM1234"}}`, w.Body.String())
}
