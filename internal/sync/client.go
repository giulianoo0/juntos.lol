package sync

import (
	"time"

	"github.com/gorilla/websocket"

	"github.com/giulianoo0/ss/internal/room"
)

const writeWait = 10 * time.Second

// Variables so tests can shrink them. A connection is alive as long as
// anything arrives on it: a pong, or the heartbeat the browser sends every
// few seconds. Pongs alone were not enough — a link busy uploading a screen
// held them back for minutes while the heartbeats kept coming, and the room
// dropped members who were right there.
var (
	pongWait   = 60 * time.Second
	pingPeriod = 30 * time.Second
)

type client struct {
	id               string
	capability       string
	member           room.Member
	conn             *websocket.Conn
	room             *roomConn
	send             chan Outbound
	report           memberReport
	telemetry        syncTelemetry
	lastTitleRequest time.Time
	// The tab said it is going: its seat is held only for a reload.
	leaving  bool
	device   string
	identity Identity
	watch    *watchSpan
	// ClientDesktop for the app, as its hello said, or "" for a browser.
	kind string
	// The hello said it can play a local source it opened from its own
	// cache; only the seat that produces the room's source does.
	localSource bool
	// The hello said it opens a local source someone else shared on its own;
	// copyFailed is the generation it could not, which it plays from the
	// bucket after all.
	localCopy  bool
	copyFailed int
	link       linkWatch
}

func (c *client) readPump() {
	defer func() {
		select {
		case c.room.unregister <- c:
		case <-c.room.done:
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
	limiter := newRateLimiter(clientMessageRules, defaultMessageRule)
	for {
		var message Inbound
		if err := c.conn.ReadJSON(&message); err != nil {
			return
		}
		if err := c.conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
			return
		}
		if message.Type == "hello" {
			continue
		}
		event := clientInbound{client: c, message: message}
		if decision := limiter.allow(message.Type, time.Now()); !decision.ok {
			if !decision.first {
				continue
			}
			event = clientInbound{client: c, rateLimited: true}
		}
		select {
		case c.room.inbound <- event:
		case <-c.room.done:
			return
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
