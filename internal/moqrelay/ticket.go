package moqrelay

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"time"
)

// TicketTTL is how long a bridge ticket opens sessions. The viewer's client
// reconnects with the same URL after a drop, so it outlives a session; a
// move to a new relay ends it sooner, as the relay it names stops serving.
const TicketTTL = 12 * time.Hour

// BridgeURL is the bridge with a ticket for one room: ss-moq-bridge serves
// the viewer only broadcasts under base, pulled from upstream.
func BridgeURL(bridge, secret, base, upstream string, now time.Time) string {
	return signTicket(bridge, secret, ticket{B: base, U: upstream, E: now.Add(TicketTTL).Unix()})
}

// BridgePublishURL is BridgeURL for a member who also writes: the bridge takes
// the one broadcast at path from them and hands it on to the relay through
// publish. It is how a network that drops UDP still shares a screen or a camera.
func BridgePublishURL(bridge, secret, base, upstream, publish, path string, now time.Time) string {
	return signTicket(bridge, secret, ticket{B: base, U: upstream, E: now.Add(TicketTTL).Unix(), P: publish, W: path})
}

type ticket struct {
	B string `json:"b"`
	U string `json:"u"`
	E int64  `json:"e"`
	P string `json:"p,omitempty"`
	W string `json:"w,omitempty"`
}

func signTicket(bridge, secret string, t ticket) string {
	payload, _ := json.Marshal(t)
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(encoded))
	return bridge + "?t=" + url.QueryEscape(encoded+"."+base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
}
