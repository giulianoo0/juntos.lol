package discord

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRegisterCommandsOverwritesTheGlobalSet(t *testing.T) {
	var got struct {
		method, path, auth string
		body               []map[string]any
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		got.method, got.path, got.auth = r.Method, r.URL.Path, r.Header.Get("Authorization")
		_ = json.Unmarshal(raw, &got.body)
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()

	api := &API{Base: server.URL, AppID: "app-1", BotToken: "bot", Client: server.Client()}
	require.NoError(t, api.RegisterCommands(t.Context()))
	require.Equal(t, http.MethodPut, got.method)
	require.Equal(t, "/applications/app-1/commands", got.path)
	require.Equal(t, "Bot bot", got.auth)

	require.Len(t, got.body, 1)
	command := got.body[0]
	require.Equal(t, "juntos", command["name"])
	require.Equal(t, []any{0.0, 1.0}, command["integration_types"], "installable on a server and on a user")
	require.Equal(t, []any{0.0, 1.0, 2.0}, command["contexts"], "usable in servers, DMs with the bot, and group DMs")
	sub := command["options"].([]any)[0].(map[string]any)
	require.Equal(t, "new", sub["name"])
	require.EqualValues(t, 1, sub["type"])
	var names []string
	for _, option := range sub["options"].([]any) {
		field := option.(map[string]any)
		names = append(names, field["name"].(string))
		require.EqualValues(t, 3, field["type"])
		require.Equal(t, false, field["required"])
	}
	require.Equal(t, []string{"nome", "senha"}, names)
}
