package sync

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
)

func TestInboundJSONContract(t *testing.T) {
	var got Inbound
	require.NoError(t, json.Unmarshal([]byte(`{
		"type":"seek",
		"positionMs":1234,
		"rate":1.25,
		"text":"hello",
		"nickname":"giuli",
		"targetId":"m2",
		"clientTimeMs":999
	}`), &got))
	require.Equal(t, "seek", got.Type)
	require.Equal(t, int64(1234), got.PositionMs)
	require.Equal(t, 1.25, got.Rate)
	require.Equal(t, "hello", got.Text)
	require.Equal(t, "giuli", got.Nickname)
	require.Equal(t, "m2", got.TargetID)
	require.Equal(t, int64(999), got.ClientTimeMs)
}

func TestOutboundOmitsUnusedFields(t *testing.T) {
	encoded, err := json.Marshal(Outbound{Type: "pong", ServerTimeMs: 123, ClientTimeMs: 100})
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"pong","serverTimeMs":123,"clientTimeMs":100}`, string(encoded))
}

func TestOutboundNestedJSONContract(t *testing.T) {
	at := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	state := room.PlayState{Playing: true, PositionMs: 1234, Rate: 1.25, ServerTimeMs: 999}
	message := room.ChatMessage{Author: "m1", Text: "hello", At: at}
	encoded, err := json.Marshal(Outbound{
		Type:         "welcome",
		State:        &state,
		ControllerID: "m1",
		Members:      []room.Member{{ID: "m1", Nickname: "giuli", JoinedAt: at}},
		Message:      &message,
		History:      []room.ChatMessage{message},
	})
	require.NoError(t, err)
	require.JSONEq(t, `{
		"type":"welcome",
		"state":{"playing":true,"positionMs":1234,"rate":1.25,"serverTimeMs":999},
		"controllerId":"m1",
		"members":[{"id":"m1","nickname":"giuli","joinedAt":"2026-08-17T12:00:00Z"}],
		"message":{"author":"m1","text":"hello","at":"2026-08-17T12:00:00Z"},
		"history":[{"author":"m1","text":"hello","at":"2026-08-17T12:00:00Z"}]
	}`, string(encoded))
}
