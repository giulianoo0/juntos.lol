// Package urlingest pulls a room's media from a URL a plugin produced.
//
// The server fetching an address chosen by third-party code is SSRF by
// construction, so the address is checked twice: once as a URL, and again as a
// resolved IP at connect time — which is the only check a DNS answer that
// changes between the two cannot slip past.
package urlingest

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"syscall"
	"time"
)

var (
	ErrBadURL         = errors.New("source url is not a url")
	ErrScheme         = errors.New("source url must be https")
	ErrPrivateAddress = errors.New("source url resolves to a private address")
)

// CheckURL validates the address itself. It cannot see where a name resolves;
// CheckAddr does that, at the moment the connection is made.
func CheckURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadURL, err)
	}
	if parsed.Scheme != "https" {
		return nil, ErrScheme
	}
	if parsed.Host == "" || parsed.Hostname() == "" {
		return nil, ErrBadURL
	}
	host := parsed.Hostname()
	if host == "localhost" || hasSuffixFold(host, ".localhost") {
		return nil, ErrPrivateAddress
	}
	if ip := net.ParseIP(host); ip != nil && !isPublic(ip) {
		return nil, ErrPrivateAddress
	}
	// Credentials would be replayed on every redirect hop, to hosts the plugin
	// picked. A public media file never needs them.
	if parsed.User != nil {
		return nil, fmt.Errorf("%w: credentials are not accepted", ErrBadURL)
	}
	return parsed, nil
}

// CheckAddr is the dialer's gate: every hop of every redirect passes here with
// an address already resolved.
func CheckAddr(_ string, addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrBadURL, err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !isPublic(ip) {
		return ErrPrivateAddress
	}
	return nil
}

// blocked holds the ranges the standard library has no predicate for.
var blocked = func() []*net.IPNet {
	ranges := []string{
		"0.0.0.0/8",      // "this network" — only the exact address is IsUnspecified
		"100.64.0.0/10",  // CGNAT: a carrier's inside, not the public internet
		"192.0.0.0/24",   // IETF protocol assignments
		"192.0.2.0/24",   // documentation
		"192.88.99.0/24", // deprecated 6to4 relay anycast
		"198.18.0.0/15",  // benchmarking
		"198.51.100.0/24",
		"203.0.113.0/24",
		"64:ff9b::/96",   // NAT64 — embeds an IPv4 address, private ones included
		"64:ff9b:1::/48", // local-use NAT64
		"2002::/16",      // 6to4, same problem
		"2001::/32",      // Teredo, also embeds IPv4
		"fec0::/10",      // deprecated IPv6 site-local
	}
	nets := make([]*net.IPNet, 0, len(ranges))
	for _, entry := range ranges {
		_, network, err := net.ParseCIDR(entry)
		if err != nil {
			panic("urlingest: bad blocked range " + entry)
		}
		nets = append(nets, network)
	}
	return nets
}()

func isPublic(ip net.IP) bool {
	// Everything that is not global unicast — loopback, link-local, multicast,
	// unspecified, broadcast — is out in one predicate.
	if !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	for _, network := range blocked {
		if network.Contains(ip) {
			return false
		}
	}
	return true
}

func hasSuffixFold(value, suffix string) bool {
	if len(value) < len(suffix) {
		return false
	}
	return equalFold(value[len(value)-len(suffix):], suffix)
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		if 'A' <= x && x <= 'Z' {
			x += 'a' - 'A'
		}
		if 'A' <= y && y <= 'Z' {
			y += 'a' - 'A'
		}
		if x != y {
			return false
		}
	}
	return true
}

// MaxRedirects bounds a chain that would otherwise be a way to spend the
// server's time for free.
const MaxRedirects = 5

// ResponseHeaderTimeout bounds how long an origin may take to say anything. It
// is the only time ceiling that belongs on a media fetch: a 10 GB film is a
// long, legitimate read, and http.Client.Timeout covers the whole body.
const ResponseHeaderTimeout = 30 * time.Second

// SafeClient builds the only client this package fetches with.
//
// The address check lives in Dialer.Control, not in Transport.DialContext, and
// the difference is the whole thing. DialContext receives "host:port" with the
// name unresolved — net.ParseIP on it returns nil for every real hostname, so
// a check there either refuses every legitimate URL or checks nothing at all.
// Control runs once per connection, after the resolver and before connect,
// with the actual IP. It also closes the window between checking a name and
// connecting to it, which is what DNS rebinding lives in.
//
// The timeout parameter is a loaded gun: any value other than zero is a
// ceiling on reading the entire body, which kills long transfers. It is there
// for short requests, and the ingest passes zero.
func SafeClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
		Control: func(network, address string, _ syscall.RawConn) error {
			return CheckAddr(network, address)
		},
	}
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= MaxRedirects {
				return fmt.Errorf("too many redirects")
			}
			_, err := CheckURL(req.URL.String())
			return err
		},
		Transport: &http.Transport{
			DialContext:           dialer.DialContext,
			ForceAttemptHTTP2:     true,
			ResponseHeaderTimeout: ResponseHeaderTimeout,
		},
	}
}
