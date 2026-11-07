package extension

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strconv"
	"time"
)

// MediaTicket lets one url through an extension's media proxy until
// expires. The host Worker checks it with the same key and signs the
// segments of a playlist it rewrites itself; extensions/host/src/ticket.ts
// is the other half.
func MediaTicket(key []byte, sub, url string, expires time.Time) string {
	exp := strconv.FormatInt(expires.Unix(), 10)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("juntos-media/1\n" + sub + "\n" + exp + "\n" + url))
	return exp + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
