package discord

import "strconv"

// Invite is one account calling a friend into the room it is in.
type Invite struct {
	From   string
	Number int64
	RoomID string
	Room   Card
}

// InviteMessage is the DM the bot sends for an invite, in the room card's
// style: who calls, the room and what it plays, and the button to join. The
// link is the room's plain address, so a locked room still asks at its door.
func InviteMessage(origin string, invite Invite) map[string]any {
	header := []any{text("### **" + escapeMarkdown(invite.From) + "** (#" + strconv.FormatInt(invite.Number, 10) + ") te chamou pra sala")}
	if invite.Room.Name != "" {
		header = append(header, text("## "+escapeMarkdown(invite.Room.Name)))
	}
	if door := doorLabel(invite.Room.Door); door != "" {
		header = append(header, text(door))
	}
	parts := []any{section(header, thumbnail(cardLogo, "juntos"))}
	if invite.Room.Playing != "" {
		playing := text("▶️ **" + escapeMarkdown(invite.Room.Playing) + "**")
		if invite.Room.Image != "" {
			parts = append(parts, section([]any{playing}, thumbnail(invite.Room.Image, invite.Room.Playing)))
		} else {
			parts = append(parts, playing)
		}
	}
	parts = append(parts, map[string]any{
		"type": componentRow,
		"components": []any{
			map[string]any{"type": componentButton, "style": buttonLink, "label": "Entrar", "url": origin + "/room/" + invite.RoomID},
		},
	})
	return cardMessage(cardAccent, parts)
}
