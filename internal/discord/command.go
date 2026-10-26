package discord

import (
	"context"
	"net/http"
	"net/url"
)

const optionString = 3

// commands is the app's global command set: /juntos new [nome] [senha].
// It can be installed on a server or on a person, and used in servers, in a
// DM with the bot and in group DMs.
func commands() []any {
	return []any{map[string]any{
		"name":              "juntos",
		"description":       "Salas do Juntos",
		"integration_types": []int{0, 1},
		"contexts":          []int{0, 1, 2},
		"options": []any{map[string]any{
			"type":        optionSubcommand,
			"name":        "new",
			"description": "Cria uma sala",
			"options": []any{
				map[string]any{"type": optionString, "name": "nome", "description": "Nome da sala", "required": false, "max_length": 80},
				map[string]any{"type": optionString, "name": "senha", "description": "Senha para entrar", "required": false, "max_length": 128},
			},
		}},
	}}
}

// RegisterCommands replaces the app's global commands with this set.
func (a *API) RegisterCommands(ctx context.Context) error {
	_, err := a.call(ctx, http.MethodPut, "/applications/"+url.PathEscape(a.AppID)+"/commands", true, commands())
	return err
}
