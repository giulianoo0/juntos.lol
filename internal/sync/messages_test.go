package sync

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
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
