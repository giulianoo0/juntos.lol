package sync

import (
	"time"

	"github.com/gorilla/websocket"

	"github.com/giulianoo0/ss/internal/room"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 30 * time.Second
)

type client struct {
	id         string
	capability string
	member     room.Member
	conn       *websocket.Conn
	room       *roomConn
	send       chan Outbound
	// report is owned by the room goroutine, like every other mutable field.
	report memberReport
	// telemetry is this member's playback story against the room clock,
	// owned by the room goroutine and written out when they leave.
	telemetry syncTelemetry
	// lastTitleRequest backs the per-member titleRequest cooldown; owned by
	// the room goroutine.
	lastTitleRequest time.Time
}

func (c *client) readPump() {
	defer func() {
		select {
		case c.room.unregister <- c:
		case <-c.room.hub.ctx.Done():
		}
	}()
	c.conn.SetReadLimit(maxWSMessageBytes)
	if err := c.conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		return
	}
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		var message Inbound
		if err := c.conn.ReadJSON(&message); err != nil {
			return
		}
		if message.Type == "hello" {
			continue
		}
		select {
		case c.room.inbound <- clientInbound{client: c, message: message}:
		case <-c.room.hub.ctx.Done():
			return
		}
	}
}

func (c *client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	defer c.conn.Close()
	for {
		select {
		case <-c.room.hub.ctx.Done():
			return
		case message, ok := <-c.send:
			if err := c.conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				return
			}
			if !ok {
				_ = c.conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(writeWait))
				return
			}
			if err := c.conn.WriteJSON(message); err != nil {
				return
			}
			if message.closeAfter {
				_ = c.conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(writeWait))
				return
			}
		case <-ticker.C:
			if err := c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait)); err != nil {
				return
			}
		}
	}
}
