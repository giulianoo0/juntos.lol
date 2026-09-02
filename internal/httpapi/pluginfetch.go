package httpapi

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
)

// The plugin hop: the one request a plugin's api.fetch turns into.
//
// The page used to perform the request itself, and the browser stamps every
// cross-site request with the page's Origin — a header no script can remove.
// Torrentio started answering 502 to any Origin that is not Stremio's own,
// and there is nothing a plugin, or the page, can do about that from inside
// a browser. So the page asks this server, and the server performs the
// request the way curl would: no Origin, no Referer, no cookie.
//
// That makes this an open GET proxy for whoever holds a session, which is
// why it is narrow. https only; a name, never an address; the name is
// resolved here and the dial refused when it lands in private space, with
// the same check on every redirect hop; the body is capped; the answer is
// served as text/plain so nothing that comes back runs as this origin; and
// each session has an hourly budget.
//
// The policy in the page (web/src/plugins/policy.ts) still decides which
// hosts a plugin may ask for. This layer does not know which plugin is
// asking, so it checks what the page cannot: where a name actually points.

// PluginFetcher performs a plugin's requests on the page's behalf.
type PluginFetcher struct {
	// MaxBytes is how much of a body travels back; the rest is dropped.
	MaxBytes int64
	// Timeout bounds the whole request, redirects included.
	Timeout time.Duration
	// selfHost is the hostname browsers load the app from, refused as a
	// target so a plugin cannot reach this API through its own server.
	selfHost string
	// resolve turns a name into addresses; allowAddr says which may be
	// dialled. Both are fields so a test can point a name at loopback.
	resolve   func(ctx context.Context, host string) ([]netip.Addr, error)
	allowAddr func(netip.Addr) bool
	transport *http.Transport
	client    *http.Client
}

// How much of an addon's answer is worth carrying. Generous for stream
// JSON; the page reads at most this much anyway.
const pluginFetchMaxBytes = 4 << 20

// A run in the page gives up after fifteen seconds; a request that has not
// answered in ten was never going to make it back in time.
const pluginFetchTimeout = 10 * time.Second

// Enough for a CDN in front of an addon, far short of a redirect loop.
const pluginFetchMaxRedirects = 5

// Longer than any addon path in practice, short enough that a request line
// is not the payload.
const pluginFetchMaxURLBytes = 2048

var errPrivateAddress = errors.New("name resolves to a non-public address")

// NewPluginFetcher returns a fetcher with the production guard: public
// addresses only, resolved through the system resolver.
func NewPluginFetcher(cfg config.Config) *PluginFetcher {
	f := &PluginFetcher{
		MaxBytes:  pluginFetchMaxBytes,
		Timeout:   pluginFetchTimeout,
		allowAddr: publicAddr,
		resolve: func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		},
	}
	if origin, err := url.Parse(cfg.PublicOrigin); err == nil {
		f.selfHost = normalizeHost(origin.Hostname())
	}
	f.transport = &http.Transport{
		// No Proxy from the environment: an HTTP_PROXY would carry the
		// request past the dialer below, and the dialer is the guard.
		Proxy:                 nil,
		DialContext:           f.dial,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: pluginFetchTimeout,
		MaxIdleConns:          32,
		IdleConnTimeout:       30 * time.Second,
	}
	if cfg.PluginFetchProxy != "" {
		// A configured proxy is the one exception, and it is deliberate:
		// torrentio refuses the instance's own address, so the hop leaves
		// from wherever the proxy is. The name is then resolved there, out
		// of this dialer's sight, so the address guard moves with it — the
		// proxy's network is what a private name would reach. What stays is
		// checkTarget: https, a name, never this server, on every redirect.
		// config.Load has already refused a proxy url that does not parse.
		proxy, _ := url.Parse(cfg.PluginFetchProxy)
		f.transport.Proxy = http.ProxyURL(proxy)
		f.transport.DialContext = (&net.Dialer{Timeout: 5 * time.Second}).DialContext
	}
	f.client = &http.Client{
		Transport: f.transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= pluginFetchMaxRedirects {
				return errors.New("too many redirects")
			}
			// The same rule as the first hop. A declared host is free to
			// answer 302 towards http://, or towards this server.
			return f.checkTarget(req.URL)
		},
	}
	return f
}

// tlsInsecureForTests makes the fetcher accept the httptest certificate,
// which is issued for 127.0.0.1 and not for the name the test dials.
func (f *PluginFetcher) tlsInsecureForTests(*http.Client) {
	f.transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // tests only
}

// dial resolves the name itself and connects to an address the guard
// admits. Resolving and dialling in one place closes the gap a rebind
// would otherwise sit in: the address checked is the address dialled.
//
// The attempts are raced, not queued. A resolver hands back IPv6 first,
// and a host with no IPv6 route lets each of those attempts hang for the
// dialer's whole timeout — two of them was the request's entire budget,
// spent before the first IPv4 address was tried. So every address starts,
// each a beat after the last, and the first to connect wins; the rest are
// cancelled, and one that connects late is closed. The same shape as the
// browser's own dialing, which is why curl never had this problem.
func (f *PluginFetcher) dial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	resolved, err := f.resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	var addrs []netip.Addr
	for _, addr := range resolved {
		if f.allowAddr(addr.Unmap()) {
			addrs = append(addrs, addr.Unmap())
		}
	}
	if len(addrs) == 0 {
		return nil, errPrivateAddress
	}
	ctx, cancel := context.WithCancel(ctx)
	type attempt struct {
		conn net.Conn
		err  error
	}
	results := make(chan attempt, len(addrs))
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	for i, addr := range addrs {
		go func() {
			if i > 0 {
				select {
				case <-time.After(time.Duration(i) * dialStagger):
				case <-ctx.Done():
					results <- attempt{err: ctx.Err()}
					return
				}
			}
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(addr.String(), port))
			results <- attempt{conn: conn, err: err}
		}()
	}
	var last error
	for i := range addrs {
		r := <-results
		if r.err == nil {
			cancel()
			// Whatever is still dialling ends with the context; whatever
			// connected in the meantime is not ours to keep.
			go func(pending int) {
				for range pending {
					if late := <-results; late.conn != nil {
						late.conn.Close()
					}
				}
			}(len(addrs) - i - 1)
			return r.conn, nil
		}
		last = r.err
	}
	cancel()
	return nil, last
}

// How long the next address waits for the one before it to connect.
const dialStagger = 250 * time.Millisecond

// publicAddr is the guard: an address the hop may connect to. Everything
// reserved is out — loopback, private, link-local (the cloud metadata
// address lives there), carrier NAT, multicast, unspecified, broadcast.
func publicAddr(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() || !a.IsGlobalUnicast() || a.IsPrivate() || a.IsLoopback() ||
		a.IsLinkLocalUnicast() || a.IsMulticast() || a.IsUnspecified() {
		return false
	}
	for _, reserved := range reservedV4 {
		if reserved.Contains(a) {
			return false
		}
	}
	return true
}

// Ranges IsGlobalUnicast and IsPrivate do not cover and that no addon lives
// in: carrier-grade NAT, "this network", the IETF protocol block, the
// benchmarking block.
var reservedV4 = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
}

// normalizeHost matches the page's spelling of a host: lowercase, no
// trailing dot, so `ss.giuli.dev.` is the same host it is to DNS.
func normalizeHost(host string) string {
	return strings.TrimRight(strings.ToLower(host), ".")
}

// checkTarget is what the page's policy already refused, refused again
// here for the hops the page never sees: every redirect.
func (f *PluginFetcher) checkTarget(u *url.URL) error {
	if u.Scheme != "https" {
		return errors.New("only https")
	}
	if u.User != nil {
		return errors.New("credentials in the url")
	}
	host := normalizeHost(u.Hostname())
	if host == "" {
		return errors.New("no host")
	}
	if _, err := netip.ParseAddr(host); err == nil || strings.HasPrefix(host, "[") {
		return errors.New("an address, not a name")
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return errors.New("local name")
	}
	if f.selfHost != "" && host == f.selfHost {
		return errors.New("this server")
	}
	return nil
}

// parseTarget reads the url a request asks for, applying checkTarget plus
// what only makes sense for the first hop: a length ceiling, and a refusal
// of the host this very request arrived at.
func (f *PluginFetcher) parseTarget(raw, requestHost string) (*url.URL, error) {
	if raw == "" {
		return nil, errors.New("url is missing")
	}
	if len(raw) > pluginFetchMaxURLBytes {
		return nil, errors.New("url is too long")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("url does not parse: %w", err)
	}
	if err := f.checkTarget(u); err != nil {
		return nil, err
	}
	if own, _, splitErr := net.SplitHostPort(requestHost); splitErr == nil {
		requestHost = own
	}
	if own := normalizeHost(requestHost); own != "" && normalizeHost(u.Hostname()) == own {
		return nil, errors.New("this server")
	}
	return u, nil
}

// RegisterPluginFetchRoute mounts GET /api/plugins/fetch. sessions and
// quota may be nil, in which case the hop is open to anyone who reaches it
// — only ever the case in tests and on a machine with no Redis.
func RegisterPluginFetchRoute(rg *gin.RouterGroup, fetcher *PluginFetcher, sessions *Sessions, quota *Quota) {
	handlers := []gin.HandlerFunc{}
	if sessions != nil {
		handlers = append(handlers, sessions.Middleware())
	}
	if quota != nil {
		handlers = append(handlers, quota.PluginFetch())
	}
	handlers = append(handlers, fetcher.handle)
	rg.GET("/plugins/fetch", handlers...)
}

func (f *PluginFetcher) handle(c *gin.Context) {
	target, err := f.parseTarget(c.Query("url"), c.Request.Host)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_url", "reason": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), f.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_url", "reason": err.Error()})
		return
	}
	// What curl sends, and what addons answer: a client, not a page.
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ss-plugin-hop)")
	req.Header.Set("Accept", "application/json, */*;q=0.8")
	resp, err := f.client.Do(req)
	if err != nil {
		// The hop's own failure, told apart from an addon's 502 by the
		// missing landing url. The reason is for the plugin author reading
		// the panel, not for the addon.
		c.JSON(http.StatusBadGateway, gin.H{"error": "upstream", "reason": err.Error()})
		return
	}
	defer resp.Body.Close()
	// Where the answer came from, after redirects, for the page's policy to
	// judge — following and then checking is the only order there is.
	c.Header("X-Final-Url", resp.Request.URL.String())
	// Never the upstream's own type. This is the app's origin; a body served
	// as text/html here would be a page of this site written by an addon.
	c.Header("Content-Type", "text/plain; charset=utf-8")
	c.Writer.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(c.Writer, io.LimitReader(resp.Body, f.MaxBytes))
}
