package httpapi

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/usage"
)

// WithUsage counts visits and the rooms they open; see package usage.
func WithUsage(counter *usage.Counter) ServerOption {
	return func(o *serverOptions) { o.usage = counter }
}

// Crawlers and test browsers run the page too, and are nobody.
var notAPerson = []string{"bot", "spider", "crawl", "headless", "preview"}

// countVisit answers the beacon each page load sends.
func countVisit(counter *usage.Counter, behindEdge bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		ua := strings.ToLower(c.Request.UserAgent())
		person := ua != ""
		for _, word := range notAPerson {
			person = person && !strings.Contains(ua, word)
		}
		if person {
			counter.Add(usage.Metrics{"visits": 1})
			counter.Distinct("visitors", requestIP(c.Request, behindEdge)+"\x00"+ua)
		}
		c.Status(http.StatusNoContent)
	}
}

// countedRoutes are the successful POSTs that make a metric of their own.
var countedRoutes = map[string]string{
	"/api/rooms":            "rooms_created",
	"/api/rooms/:id/source": "sources",
}

// countRoutes tallies every request to a counted route that succeeded.
func countRoutes(counter *usage.Counter) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		metric, counted := countedRoutes[c.FullPath()]
		if counted && c.Request.Method == http.MethodPost && c.Writer.Status() < 300 {
			counter.Add(usage.Metrics{metric: 1})
		}
	}
}
