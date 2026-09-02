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

// RegisterRelayRoute streams /relay/{worker}/... to the worker's real base so
// browsers never learn its address. Authorization is the ticket in the path,
// which the destination worker verifies.
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
			FlushInterval: -1,
			ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
				slog.Debug("relay proxy error", "worker", workerID, "error", err)
				w.WriteHeader(http.StatusBadGateway)
			},
		}
		proxy.ServeHTTP(c.Writer, c.Request)
	})
}
