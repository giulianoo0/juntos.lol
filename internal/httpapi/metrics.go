package httpapi

import (
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/metrics"
)

// otherRoute is where requests that matched no route are counted. Using the
// path itself would mint a time series per URL anyone ever probed, which is a
// denial of service against the metrics endpoint dressed up as a 404.
const otherRoute = "other"

// requestMetrics records what each request cost and how many bytes it moved.
//
// Bytes are counted here, on the wire, rather than derived from anything the
// handlers know. That is what makes the bandwidth panels rate() over a
// counter: the upload leg is the tus route's request bodies and the download
// leg is what every route wrote back, both of them monotonic, both of them
// turned into a per-second figure by whoever is asking rather than by this
// process guessing at an interval.
func requestMetrics() gin.HandlerFunc {
	return func(c *gin.Context) {
		started := time.Now()
		body := &countingBody{inner: c.Request.Body}
		if c.Request.Body != nil {
			c.Request.Body = body
		}

		c.Next()

		route := routeLabel(c)
		metrics.HTTPRequests.WithLabelValues(route, c.Request.Method, strconv.Itoa(c.Writer.Status())).Inc()
		// A WebSocket is one request that lasts as long as the film does, so
		// timing it would put a two-hour observation in the same histogram as
		// a playlist read and drag every quantile on the panel with it. The
		// hub counts the connections and the frames instead.
		if !isWebsocket(c) {
			metrics.HTTPDuration.WithLabelValues(route, c.Request.Method).Observe(time.Since(started).Seconds())
		}
		if read := body.read; read > 0 {
			metrics.HTTPRequestBytes.WithLabelValues(route).Add(float64(read))
		}
		if written := c.Writer.Size(); written > 0 {
			metrics.HTTPResponseBytes.WithLabelValues(route).Add(float64(written))
		}
	}
}

// routeLabel is the matched route template, which is a closed set the router
// already owns, never the request path.
func routeLabel(c *gin.Context) string {
	if route := c.FullPath(); route != "" {
		return route
	}
	return otherRoute
}

func isWebsocket(c *gin.Context) bool {
	return strings.HasPrefix(c.Request.URL.Path, "/ws/")
}

// countingBody totals the request body bytes a handler actually consumed.
//
// Content-Length would be cheaper to read but wrong twice over: a chunked
// body does not carry one, and a request the handler abandons halfway through
// never moved the bytes it promised.
type countingBody struct {
	inner io.ReadCloser
	read  int64
}

func (b *countingBody) Read(p []byte) (int, error) {
	n, err := b.inner.Read(p)
	b.read += int64(n)
	return n, err
}

func (b *countingBody) Close() error { return b.inner.Close() }
