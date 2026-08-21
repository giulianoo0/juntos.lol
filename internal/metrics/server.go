package metrics

import (
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// metricsReadHeaderTimeout bounds how long a connection may hold the listener
// open without saying what it wants.
const metricsReadHeaderTimeout = 5 * time.Second

// Serve exposes /metrics on its own listener and returns once it is bound.
//
// It is a second listener rather than a route on the application's engine
// because the two have different audiences. The application is published to
// the host and put behind a TLS proxy; this one is not published at all, so
// it is reachable from the Compose network — where the collector runs — and
// from nowhere else. Nothing here is secret in the ordinary sense, but the
// series do describe how many people are watching what and how the machine is
// spending itself, which is nobody's business but the operator's.
//
// The bind happens before returning on purpose: a port already in use is a
// deployment mistake worth reporting at boot, not a goroutine that dies in
// silence and leaves a scrape target answering nothing.
func Serve(port int) error {
	address := fmt.Sprintf(":%d", port)
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("metrics: listen on %s: %w", address, err)
	}

	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(prometheus.DefaultGatherer, promhttp.HandlerOpts{
		// A failing collector is reported through the endpoint's own error
		// counter and the scrape fails loudly, rather than a truncated
		// exposition that reads as "those series stopped existing".
		ErrorHandling: promhttp.HTTPErrorOnError,
	}))
	server := &http.Server{Handler: mux, ReadHeaderTimeout: metricsReadHeaderTimeout}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			slog.Error("metrics endpoint stopped", "error", err)
		}
	}()
	slog.Info("metrics endpoint listening", "address", address)
	return nil
}
