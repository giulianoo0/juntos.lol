package discord

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

// FriendRequest is one account asking another to be friends.
type FriendRequest struct {
	From   string
	Number int64
	To     int64
}

// FriendOutcome is how a friend request ended when answered from Discord.
type FriendOutcome int

const (
	FriendAccepted FriendOutcome = iota
	FriendDeclined
	// FriendGone is a request already answered on the site, or withdrawn.
	FriendGone
	FriendAlready
)

// FriendAnswer is the request's end, with who had asked.
type FriendAnswer struct {
	Outcome FriendOutcome
	From    string
	Number  int64
}

// ErrNotYours is a click on a friend request by someone it wasn't sent to.
var ErrNotYours = errors.New("friend request not addressed to this user")

// FriendAnswerer answers a friend request for the Discord user who clicked,
// who must be the account the request was sent to.
type FriendAnswerer interface {
	AnswerFriend(ctx context.Context, discordUserID string, to, from int64, accept bool) (FriendAnswer, error)
}

const (
	buttonSuccess = 3
	buttonDanger  = 4

	responseUpdateMessage = 7
)

// friendCustomID names a button of the request's DM. It carries both
// accounts, but only says what the click asks for: the server still checks
// the clicker is `to`.
func friendCustomID(accept bool, from, to int64) string {
	verb := "decline"
	if accept {
		verb = "accept"
	}
	return "friend:" + verb + ":" + strconv.FormatInt(from, 10) + ":" + strconv.FormatInt(to, 10)
}

func parseFriendCustomID(customID string) (accept bool, from, to int64, ok bool) {
	parts := strings.Split(customID, ":")
	if len(parts) != 4 || parts[0] != "friend" || (parts[1] != "accept" && parts[1] != "decline") {
		return false, 0, 0, false
	}
	from, errFrom := strconv.ParseInt(parts[2], 10, 64)
	to, errTo := strconv.ParseInt(parts[3], 10, 64)
	if errFrom != nil || errTo != nil || from <= 0 || to <= 0 || from == to {
		return false, 0, 0, false
	}
	return parts[1] == "accept", from, to, true
}

func friendHeader(from string, number int64) string {
	return "**" + escapeMarkdown(from) + "** (#" + strconv.FormatInt(number, 10) + ")"
}

// FriendRequestMessage is the DM the bot sends for a friend request, with
// Aceitar and Recusar right there and the asker's profile.
func FriendRequestMessage(origin string, request FriendRequest) map[string]any {
	header := text("### " + friendHeader(request.From, request.Number) + " te mandou um pedido de amizade")
	return cardMessage(cardAccent, []any{
		section([]any{header}, thumbnail(cardLogo, "juntos")),
		map[string]any{
			"type": componentRow,
			"components": []any{
				map[string]any{"type": componentButton, "style": buttonSuccess, "label": "Aceitar", "custom_id": friendCustomID(true, request.Number, request.To)},
				map[string]any{"type": componentButton, "style": buttonDanger, "label": "Recusar", "custom_id": friendCustomID(false, request.Number, request.To)},
				map[string]any{"type": componentButton, "style": buttonLink, "label": "Ver perfil", "url": ProfileURL(origin, request.Number)},
			},
		},
	})
}

// friendAnsweredMessage replaces the request's DM once answered: no buttons
// left to click but the profile.
func friendAnsweredMessage(origin string, answer FriendAnswer) map[string]any {
	var line string
	accent := cardAccent
	switch answer.Outcome {
	case FriendAccepted:
		line = "✅ Agora vocês são amigos"
	case FriendAlready:
		line = "✅ Vocês já são amigos"
	case FriendDeclined:
		line, accent = "Pedido recusado", cardClosedAccent
	default:
		line, accent = "Esse pedido não vale mais", cardClosedAccent
	}
	parts := []any{text("### " + friendHeader(answer.From, answer.Number)), text(line)}
	if answer.Number > 0 {
		parts = append(parts, map[string]any{
			"type": componentRow,
			"components": []any{
				map[string]any{"type": componentButton, "style": buttonLink, "label": "Ver perfil", "url": ProfileURL(origin, answer.Number)},
			},
		})
	}
	return cardMessage(accent, parts)
}

// ProfileURL is an account's page on the site.
func ProfileURL(origin string, id int64) string {
	return origin + "/c/" + strconv.FormatInt(id, 10)
}

// friendButton answers Aceitar or Recusar on a friend request's DM by
// editing that message in place.
func (h *Handler) friendButton(w http.ResponseWriter, ctx context.Context, call interaction, accept bool, from, to int64) {
	who := clicker(call)
	if who == nil || who.ID == "" || h.Friends == nil {
		writeJSON(w, ephemeral("Não deu para responder agora."))
		return
	}
	answer, err := h.Friends.AnswerFriend(ctx, who.ID, to, from, accept)
	if errors.Is(err, ErrNotYours) {
		writeJSON(w, ephemeral("Esse pedido não é pra você."))
		return
	}
	if err != nil {
		writeJSON(w, ephemeral("Não deu para responder agora. Tente de novo."))
		return
	}
	writeJSON(w, map[string]any{"type": responseUpdateMessage, "data": friendAnsweredMessage(h.Origin, answer)})
}
