// Package discord is the Juntos app on Discord: the /juntos new command that
// opens a room, and the card that shows the room in the channel it came from.
// Discord calls the server over HTTP; the server writes back through the
// interaction's token while it lasts, or through the bot when the app is
// installed on the server.
package discord

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// NewRoom is what /juntos new asks for. The one who ran it is the host.
type NewRoom struct {
	Nickname string
	Name     string
	Password string
}

type CreatedRoom struct {
	ID         string
	OwnerToken string
}

// RoomCreator opens a room the same way the site's own form does.
type RoomCreator interface {
	CreateRoom(ctx context.Context, request NewRoom) (CreatedRoom, error)
}

// interactionTokenLife is how long Discord honours an interaction's token for
// follow-ups and edits.
const interactionTokenLife = 15 * time.Minute

const maxInteractionBytes = 64 << 10

const (
	interactionPing      = 1
	interactionCommand   = 2
	interactionComponent = 3

	responsePong    = 1
	responseMessage = 4

	flagEphemeral = 64

	componentRow    = 1
	componentButton = 2
	buttonSecondary = 2
	buttonLink      = 5

	optionSubcommand = 1
)

// Handler serves POST /api/discord/interactions.
type Handler struct {
	PublicKey ed25519.PublicKey
	Rooms     RoomCreator
	Links     *LinkStore
	// Origin is the site's public origin, for the links the app hands out.
	Origin string
	Now    func() time.Time
}

// Verify checks Discord's signature over the timestamp and the raw body.
func Verify(key ed25519.PublicKey, signatureHex, timestamp string, body []byte) bool {
	signature, err := hex.DecodeString(signatureHex)
	if err != nil || len(signature) != ed25519.SignatureSize || timestamp == "" || len(key) != ed25519.PublicKeySize {
		return false
	}
	message := make([]byte, 0, len(timestamp)+len(body))
	message = append(message, timestamp...)
	message = append(message, body...)
	return ed25519.Verify(key, message, signature)
}

type user struct {
	ID         string `json:"id"`
	Username   string `json:"username"`
	GlobalName string `json:"global_name"`
}

type option struct {
	Type    int             `json:"type"`
	Name    string          `json:"name"`
	Value   json.RawMessage `json:"value"`
	Options []option        `json:"options"`
}

type interaction struct {
	Type                         int               `json:"type"`
	Token                        string            `json:"token"`
	ChannelID                    string            `json:"channel_id"`
	GuildID                      string            `json:"guild_id"`
	AuthorizingIntegrationOwners map[string]string `json:"authorizing_integration_owners"`
	Member                       *struct {
		User user `json:"user"`
	} `json:"member"`
	User *user `json:"user"`
	Data struct {
		Name     string   `json:"name"`
		Options  []option `json:"options"`
		CustomID string   `json:"custom_id"`
	} `json:"data"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxInteractionBytes))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !Verify(h.PublicKey, r.Header.Get("X-Signature-Ed25519"), r.Header.Get("X-Signature-Timestamp"), body) {
		http.Error(w, "invalid request signature", http.StatusUnauthorized)
		return
	}
	var call interaction
	if err := json.Unmarshal(body, &call); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	switch call.Type {
	case interactionPing:
		writeJSON(w, map[string]any{"type": responsePong})
	case interactionCommand:
		h.command(w, r.Context(), call)
	case interactionComponent:
		h.component(w, call)
	default:
		http.Error(w, "unsupported interaction", http.StatusBadRequest)
	}
}

func (h *Handler) command(w http.ResponseWriter, ctx context.Context, call interaction) {
	if call.Data.Name != "juntos" || len(call.Data.Options) == 0 || call.Data.Options[0].Name != "new" {
		writeJSON(w, ephemeral("Comando desconhecido."))
		return
	}
	request := NewRoom{Nickname: displayName(call)}
	for _, field := range call.Data.Options[0].Options {
		var value string
		if json.Unmarshal(field.Value, &value) != nil {
			continue
		}
		switch field.Name {
		case "nome":
			request.Name = strings.TrimSpace(value)
		case "senha":
			request.Password = value
		}
	}
	created, err := h.Rooms.CreateRoom(ctx, request)
	if err != nil {
		slog.ErrorContext(ctx, "discord create room failed", "error", err)
		writeJSON(w, ephemeral("Não deu para criar a sala agora. Tente de novo."))
		return
	}
	_, guildInstalled := call.AuthorizingIntegrationOwners["0"]
	link := Link{
		ChannelID:        call.ChannelID,
		GuildID:          call.GuildID,
		InteractionToken: call.Token,
		TokenExpiresAt:   h.now().Add(interactionTokenLife),
		GuildInstalled:   guildInstalled,
		Name:             request.Name,
		Locked:           request.Password != "",
	}
	if err := h.Links.Put(ctx, created.ID, link); err != nil {
		slog.ErrorContext(ctx, "discord store link failed", "room_id", created.ID, "error", err)
	}
	host := h.Origin + "/room/" + created.ID + "#owner=" + created.OwnerToken
	writeJSON(w, map[string]any{
		"type": responseMessage,
		"data": map[string]any{
			"flags":   flagEphemeral,
			"content": "Sala pronta.",
			"components": []any{map[string]any{
				"type": componentRow,
				"components": []any{map[string]any{
					"type": componentButton, "style": buttonLink, "label": "Entrar como host", "url": host,
				}},
			}},
		},
	})
}

// component answers the card's "Copiar link": Discord buttons cannot write
// to the clipboard, so the link comes back as text only the clicker sees.
func (h *Handler) component(w http.ResponseWriter, call interaction) {
	roomID, ok := strings.CutPrefix(call.Data.CustomID, "copy:")
	if !ok || roomID == "" {
		http.Error(w, "unsupported component", http.StatusBadRequest)
		return
	}
	writeJSON(w, ephemeral(h.Origin+"/room/"+roomID))
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

func displayName(call interaction) string {
	var who *user
	if call.Member != nil {
		who = &call.Member.User
	} else {
		who = call.User
	}
	if who == nil {
		return ""
	}
	if who.GlobalName != "" {
		return who.GlobalName
	}
	return who.Username
}

func ephemeral(content string) map[string]any {
	return map[string]any{"type": responseMessage, "data": map[string]any{"flags": flagEphemeral, "content": content}}
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}
