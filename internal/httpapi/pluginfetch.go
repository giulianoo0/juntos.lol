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

// The plugin hop: the server performs a plugin's request the way curl would,
// because the browser stamps every cross-site request with the page's Origin
// and some addons refuse any Origin but their own. Narrow on purpose: https
// only, a name never an address, resolved here and refused when it lands in
// private space on every redirect hop, body capped, served as text/plain,
// and an hourly budget per session. The page's policy still decides which
// hosts a plugin may ask for; this layer checks where a name actually points.

type PluginFetcher struct {
	MaxBytes  int64
	Timeout   time.Duration
	selfHost  string
	resolve   func(ctx context.Context, host string) ([]netip.Addr, error)
	allowAddr func(netip.Addr) bool
	transport *http.Transport
	client    *http.Client
}

const pluginFetchMaxBytes = 4 << 20

const pluginFetchTimeout = 10 * time.Second

const pluginFetchMaxRedirects = 5

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
		Proxy:                 nil,
		DialContext:           f.dial,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: pluginFetchTimeout,
		MaxIdleConns:          32,
		IdleConnTimeout:       30 * time.Second,
	}
	if cfg.PluginFetchProxy != "" {
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
			return f.checkTarget(req.URL)
		},
	}
	return f
}

func (f *PluginFetcher) tlsInsecureForTests(*http.Client) {
	f.transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // tests only
}

// dial resolves the name itself and connects to an address the guard admits,
// so the address checked is the address dialled. Attempts are raced with a
// stagger, not queued: a black-hole IPv6 answer must not spend the budget.
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

const dialStagger = 250 * time.Millisecond

// publicAddr is the guard: everything reserved is out — loopback, private,
// link-local, carrier NAT, multicast, unspecified.
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

var reservedV4 = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
}

func normalizeHost(host string) string {
	return strings.TrimRight(strings.ToLower(host), ".")
}

// checkTarget is the page's url policy applied again, on every hop the page
// never sees: https, a name, never local, never this server.
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

// parseTarget is checkTarget plus what only the first hop needs: a length
// ceiling, and a refusal of the host this very request arrived at.
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

// RegisterPluginFetchRoute mounts GET /api/plugins/fetch; a nil sessions or
// quota leaves the hop open, which only tests and a Redis-less machine do.
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
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ss-plugin-hop)")
	req.Header.Set("Accept", "application/json, */*;q=0.8")
	resp, err := f.client.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "upstream", "reason": err.Error()})
		return
	}
	defer resp.Body.Close()
	c.Header("X-Final-Url", resp.Request.URL.String())
	c.Header("Content-Type", "text/plain; charset=utf-8")
	c.Writer.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(c.Writer, io.LimitReader(resp.Body, f.MaxBytes))
}
