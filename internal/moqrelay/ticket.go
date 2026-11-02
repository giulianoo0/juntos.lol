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
	payload, _ := json.Marshal(struct {
		B string `json:"b"`
		U string `json:"u"`
		E int64  `json:"e"`
	}{base, upstream, now.Add(TicketTTL).Unix()})
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(encoded))
	return bridge + "?t=" + url.QueryEscape(encoded+"."+base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
}
