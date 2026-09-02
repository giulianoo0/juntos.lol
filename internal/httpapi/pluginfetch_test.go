package httpapi

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/config"
)

// upstreamRig is a TLS upstream reachable as https://addon.test, the way a
// real addon would be: the hop resolves the name itself, so the test hands
// it a resolver that answers with the loopback the server listens on, and a
// guard that lets loopback through — the one address the real guard exists
// to refuse.
type upstreamRig struct {
	server *httptest.Server
	hits   []*http.Request
}

func newUpstream(t *testing.T, handler http.HandlerFunc) *upstreamRig {
	t.Helper()
	rig := &upstreamRig{}
	rig.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rig.hits = append(rig.hits, r.Clone(context.Background()))
		handler(w, r)
	}))
	t.Cleanup(rig.server.Close)
	return rig
}

func (u *upstreamRig) port() string {
	_, port, _ := net.SplitHostPort(u.server.Listener.Addr().String())
	return port
}

// newHopRig mounts the hop over the upstream, with a resolver that maps every
// name onto the upstream's loopback and a guard that admits it.
func newHopRig(t *testing.T, upstream *upstreamRig, opts ...func(*PluginFetcher)) *gin.Engine {
	t.Helper()
	fetcher := NewPluginFetcher(config.Config{PublicOrigin: "https://ss.test"})
	fetcher.resolve = func(_ context.Context, host string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	}
	fetcher.allowAddr = func(netip.Addr) bool { return true }
	// The httptest certificate is for 127.0.0.1, not for addon.test.
	fetcher.tlsInsecureForTests(upstream.server.Client())
	for _, apply := range opts {
		apply(fetcher)
	}
	r := gin.New()
	RegisterPluginFetchRoute(r.Group("/api"), fetcher, nil, nil)
	return r
}

func hop(r *gin.Engine, target string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/plugins/fetch?url="+url.QueryEscape(target), nil)
	req.Host = "ss.test"
	r.ServeHTTP(w, req)
	return w
}

func TestPluginFetchRelaysTheAddonAnswerWithoutABrowserOrigin(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTeapot)
		_, _ = io.WriteString(w, `{"streams":[]}`)
	})
	r := newHopRig(t, upstream)
	target := "https://addon.test:" + upstream.port() + "/stream/movie/tt1.json?x=1"

	w := hop(r, target)

	require.Equal(t, http.StatusTeapot, w.Code, "the addon's status travels back verbatim")
	require.Equal(t, `{"streams":[]}`, w.Body.String())
	require.Equal(t, target, w.Header().Get("X-Final-Url"))
	// Never the upstream's type: a page served as text/html from this origin
	// would run as this origin.
	require.Equal(t, "text/plain; charset=utf-8", w.Header().Get("Content-Type"))
	require.Len(t, upstream.hits, 1)
	hit := upstream.hits[0]
	require.Equal(t, "/stream/movie/tt1.json", hit.URL.Path)
	require.Equal(t, "x=1", hit.URL.RawQuery)
	require.Equal(t, "addon.test:"+upstream.port(), hit.Host)
	require.Empty(t, hit.Header.Get("Origin"), "the whole point: no Origin reaches the addon")
	require.Empty(t, hit.Header.Get("Cookie"))
	require.Empty(t, hit.Header.Get("Referer"))
}

func TestPluginFetchFollowsRedirectsAndReportsWhereItLanded(t *testing.T) {
	var port string
	upstream := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/old" {
			http.Redirect(w, r, "https://elsewhere.test:"+port+"/new", http.StatusFound)
			return
		}
		_, _ = io.WriteString(w, "landed")
	})
	port = upstream.port()
	r := newHopRig(t, upstream)

	w := hop(r, "https://addon.test:"+port+"/old")

	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, "landed", w.Body.String())
	require.Equal(t, "https://elsewhere.test:"+port+"/new", w.Header().Get("X-Final-Url"))
}

func TestPluginFetchRefusesARedirectOffHTTPS(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://addon.test/plain", http.StatusFound)
	})
	r := newHopRig(t, upstream)

	w := hop(r, "https://addon.test:"+upstream.port()+"/old")

	require.Equal(t, http.StatusBadGateway, w.Code)
	require.Empty(t, w.Header().Get("X-Final-Url"), "a failure of the hop carries no landing url")
	require.Contains(t, w.Body.String(), "upstream")
}

func TestPluginFetchRefusesWhatThePolicyRefuses(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {})
	r := newHopRig(t, upstream)
	for _, target := range []string{
		"",
		"not a url",
		"http://addon.test/x",
		"ftp://addon.test/x",
		"https://127.0.0.1/x",
		"https://[::1]/x",
		"https://localhost/x",
		"https://api.localhost/x",
		"https://ss.test/api/rooms",
		"https://SS.TEST./api/rooms",
		"https://user:pw@addon.test/x",
		"https://" + strings.Repeat("a", 2100) + ".test/x",
	} {
		w := hop(r, target)
		require.Equal(t, http.StatusBadRequest, w.Code, "target %q", target)
		require.Empty(t, upstream.hits, "target %q reached the upstream", target)
	}
}

func TestPluginFetchRefusesANameThatResolvesIntoPrivateSpace(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {})
	for _, private := range []string{"10.0.0.8", "127.0.0.1", "169.254.169.254", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.8"} {
		r := newHopRig(t, upstream, func(f *PluginFetcher) {
			f.resolve = func(context.Context, string) ([]netip.Addr, error) {
				return []netip.Addr{netip.MustParseAddr(private)}, nil
			}
			f.allowAddr = publicAddr
		})
		w := hop(r, "https://addon.test:"+upstream.port()+"/x")
		require.Equal(t, http.StatusBadGateway, w.Code, "address %s", private)
		require.Empty(t, upstream.hits, "address %s reached the upstream", private)
	}
}

func TestPluginFetchDoesNotWaitOnAnAddressThatNeverAnswers(t *testing.T) {
	// The resolver's first answer is a black hole, the way an IPv6 address
	// is on a host with no IPv6 route. Queued dialing would spend the
	// dialer's whole timeout on it before trying the second.
	upstream := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	})
	r := newHopRig(t, upstream, func(f *PluginFetcher) {
		f.resolve = func(context.Context, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("10.255.255.1"), netip.MustParseAddr("127.0.0.1")}, nil
		}
	})

	started := time.Now()
	w := hop(r, "https://addon.test:"+upstream.port()+"/x")

	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, "ok", w.Body.String())
	require.Less(t, time.Since(started), 3*time.Second)
}

// connectProxy is the smallest CONNECT proxy: it tunnels to whatever host
// the client names, and records what it was asked for.
func connectProxy(t *testing.T) (*httptest.Server, *[]string) {
	t.Helper()
	asked := &[]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "connect only", http.StatusMethodNotAllowed)
			return
		}
		*asked = append(*asked, r.Host)
		// The proxy is what resolves the name; here every name is loopback.
		_, port, _ := net.SplitHostPort(r.Host)
		upstream, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", port))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
		client, _, err := http.NewResponseController(w).Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		go func() { defer client.Close(); _, _ = io.Copy(client, upstream) }()
		go func() { defer upstream.Close(); _, _ = io.Copy(upstream, client) }()
	}))
	t.Cleanup(server.Close)
	return server, asked
}

func TestPluginFetchLeavesThroughTheConfiguredProxy(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "via proxy")
	})
	proxy, asked := connectProxy(t)
	// The production guard stays: the proxy is on loopback and the addon
	// resolves to loopback, and neither is this fetcher's to refuse — the
	// dial goes to the proxy, the name goes with the CONNECT.
	fetcher := NewPluginFetcher(config.Config{PublicOrigin: "https://ss.test", PluginFetchProxy: proxy.URL})
	fetcher.tlsInsecureForTests(upstream.server.Client())
	r := gin.New()
	RegisterPluginFetchRoute(r.Group("/api"), fetcher, nil, nil)

	w := hop(r, "https://addon.test:"+upstream.port()+"/x")

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, "via proxy", w.Body.String())
	require.Equal(t, []string{"addon.test:" + upstream.port()}, *asked)
	require.Len(t, upstream.hits, 1)
	require.Empty(t, upstream.hits[0].Header.Get("Origin"))

	// The url policy does not move with the guard.
	for _, target := range []string{"http://addon.test/x", "https://localhost/x", "https://ss.test/api", "https://127.0.0.1/x"} {
		require.Equal(t, http.StatusBadRequest, hop(r, target).Code, target)
	}
	require.Len(t, *asked, 1)
}

func TestPluginFetchCapsTheBody(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Repeat("x", 100))
	})
	r := newHopRig(t, upstream, func(f *PluginFetcher) { f.MaxBytes = 40 })

	w := hop(r, "https://addon.test:"+upstream.port()+"/big")

	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, strings.Repeat("x", 40), w.Body.String())
}

func TestPluginFetchOnlyAnswersGET(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {})
	r := newHopRig(t, upstream)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/plugins/fetch?url=https%3A%2F%2Faddon.test%2Fx", nil))
	require.Equal(t, http.StatusNotFound, w.Code)
	require.Empty(t, upstream.hits)
}

func TestPluginFetchSpendsTheSessionBudget(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	})
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	sessions := NewSessions(rdb, time.Hour, 0, false)
	quota := NewQuota(rdb, 0, 0, 0)
	quota.pluginFetchPerHour = 2

	fetcher := NewPluginFetcher(config.Config{})
	fetcher.resolve = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	}
	fetcher.allowAddr = func(netip.Addr) bool { return true }
	fetcher.tlsInsecureForTests(upstream.server.Client())
	r := gin.New()
	RegisterPluginFetchRoute(r.Group("/api"), fetcher, sessions, quota)

	target := "https://addon.test:" + upstream.port() + "/x"
	first := hop(r, target)
	require.Equal(t, http.StatusOK, first.Code)
	cookies := first.Result().Cookies()
	require.Len(t, cookies, 1)
	for i, want := range []int{http.StatusOK, http.StatusTooManyRequests} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/plugins/fetch?url="+url.QueryEscape(target), nil)
		req.AddCookie(cookies[0])
		r.ServeHTTP(w, req)
		require.Equal(t, want, w.Code, "request %d after the first", i+1)
	}
	require.Len(t, upstream.hits, 2)
}

func TestPublicAddr(t *testing.T) {
	for _, ok := range []string{"93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "1.1.1.1"} {
		require.True(t, publicAddr(netip.MustParseAddr(ok)), ok)
	}
	for _, bad := range []string{
		"0.0.0.0", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.1.1", "100.64.0.1",
		"224.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fc00::1", "ff02::1", "::ffff:192.168.0.1",
	} {
		require.False(t, publicAddr(netip.MustParseAddr(bad)), bad)
	}
}
