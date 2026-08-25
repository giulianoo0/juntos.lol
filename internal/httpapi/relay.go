package httpapi

import (
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/worker"
)

// The relay: browsers reach private workers through the fleet's front door
// instead of learning their addresses. This handler is the middle hop —
// it forwards /relay/{worker}/... to the worker's real base, streaming,
// never buffering, and only for workers that asked to be relayed. It adds
// no authorization of its own because the destination worker verifies the
// ticket in the path, exactly as it does for direct readers.
func RegisterRelayRoute(r gin.IRoutes, service *worker.Service) {
	if service == nil {
		return
	}
	r.Any("/relay/:workerID/*rest", func(c *gin.Context) {
		workerID := c.Param("workerID")
		base, ok := service.RelayTarget(workerID)
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "unknown_worker"})
			return
		}
		target, err := url.Parse(base)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "bad_worker_base"})
			return
		}
		prefix := "/relay/" + workerID
		proxy := &httputil.ReverseProxy{
			Rewrite: func(pr *httputil.ProxyRequest) {
				pr.Out.URL.Scheme = target.Scheme
				pr.Out.URL.Host = target.Host
				pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, prefix)
				pr.Out.URL.RawQuery = pr.In.URL.RawQuery
				pr.Out.Host = target.Host
			},
			// Range bodies stream as the pieces arrive; buffering them would
			// reintroduce the exact latency the streaming design removes.
			FlushInterval: -1,
			ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
				slog.Debug("relay proxy error", "worker", workerID, "error", err)
				w.WriteHeader(http.StatusBadGateway)
			},
		}
		proxy.ServeHTTP(c.Writer, c.Request)
	})
}
