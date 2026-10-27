package discord

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

type answerCall struct {
	DiscordUserID string
	To, From      int64
	Accept        bool
}

// fakeFriends lets only Discord user "bia-discord" answer for account 2.
type fakeFriends struct{ calls []answerCall }

func (f *fakeFriends) AnswerFriend(_ context.Context, discordUserID string, to, from int64, accept bool) (FriendAnswer, error) {
	f.calls = append(f.calls, answerCall{discordUserID, to, from, accept})
	if discordUserID != "bia-discord" || to != 2 {
		return FriendAnswer{}, ErrNotYours
	}
	outcome := FriendDeclined
	if accept {
		outcome = FriendAccepted
	}
	return FriendAnswer{Outcome: outcome, From: "Ana", Number: from}, nil
}

func TestFriendRequestMessageCarriesBothButtons(t *testing.T) {
	message := FriendRequestMessage("https://juntos.test", FriendRequest{From: "Ana_", Number: 1, To: 2})
	raw, err := json.Marshal(message)
	require.NoError(t, err)
	body := string(raw)
	require.Contains(t, body, `"flags":32768`)
	require.Contains(t, body, `"allowed_mentions":{"parse":[]}`)
	require.Contains(t, body, `**Ana\\_** (#1)`)
	require.Contains(t, body, `"custom_id":"friend:accept:1:2"`)
	require.Contains(t, body, `"custom_id":"friend:decline:1:2"`)
	require.Contains(t, body, `"url":"https://juntos.test/c/1"`)
}

func TestFriendButtons(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		wantCall *answerCall
		want     string
		refused  bool
	}{
		{
			name:     "o destinatário aceita na DM",
			body:     `{"type":3,"user":{"id":"bia-discord"},"data":{"custom_id":"friend:accept:1:2"}}`,
			wantCall: &answerCall{"bia-discord", 2, 1, true},
			want:     "Agora vocês são amigos",
		},
		{
			name:     "o destinatário recusa",
			body:     `{"type":3,"user":{"id":"bia-discord"},"data":{"custom_id":"friend:decline:1:2"}}`,
			wantCall: &answerCall{"bia-discord", 2, 1, false},
			want:     "Pedido recusado",
		},
		{
			name:     "outra pessoa não aceita por ele",
			body:     `{"type":3,"member":{"user":{"id":"caio-discord"}},"data":{"custom_id":"friend:accept:1:2"}}`,
			wantCall: &answerCall{"caio-discord", 2, 1, true},
			want:     "não é pra você",
			refused:  true,
		},
		{
			name: "custom_id torto não chega a responder",
			body: `{"type":3,"user":{"id":"bia-discord"},"data":{"custom_id":"friend:accept:1:1"}}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler, key, _, _ := newHandler(t)
			friends := &fakeFriends{}
			handler.Friends = friends
			w := httptest.NewRecorder()

			handler.ServeHTTP(w, signed(t, key, tt.body))

			if tt.wantCall == nil {
				require.Equal(t, http.StatusBadRequest, w.Code)
				require.Empty(t, friends.calls)
				return
			}
			require.Equal(t, http.StatusOK, w.Code)
			require.Equal(t, []answerCall{*tt.wantCall}, friends.calls)
			require.Contains(t, w.Body.String(), tt.want)
			var response struct {
				Type int `json:"type"`
				Data struct {
					Flags int `json:"flags"`
				} `json:"data"`
			}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
			if tt.refused {
				require.Equal(t, responseMessage, response.Type)
				require.Equal(t, flagEphemeral, response.Data.Flags, "a recusa só quem clicou vê")
				return
			}
			require.Equal(t, responseUpdateMessage, response.Type, "a resposta troca a própria DM")
			require.Equal(t, flagComponentsV2, response.Data.Flags)
			require.NotContains(t, w.Body.String(), "custom_id", "sem botões depois de respondido")
		})
	}
}

func TestFriendButtonsRefuseUnsignedCalls(t *testing.T) {
	handler, _, _, _ := newHandler(t)
	friends := &fakeFriends{}
	handler.Friends = friends
	request := httptest.NewRequest(http.MethodPost, "/api/discord/interactions",
		bytes.NewBufferString(`{"type":3,"user":{"id":"bia-discord"},"data":{"custom_id":"friend:accept:1:2"}}`))
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, request)

	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Empty(t, friends.calls)
}
