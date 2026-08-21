package metrics

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// freePort asks the kernel for a port nobody is using, so the test does not
// pick one and hope.
func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := listener.Addr().(*net.TCPAddr).Port
	require.NoError(t, listener.Close())
	return port
}

func TestServeExposesTheApplicationSeries(t *testing.T) {
	port := freePort(t)
	require.NoError(t, Serve(port))
	RoomsCreated.WithLabelValues("upload").Inc()

	response, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/metrics", port))
	require.NoError(t, err)
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)

	require.Equal(t, http.StatusOK, response.StatusCode)
	exposition := string(body)
	require.Contains(t, exposition, "ss_rooms_created_total")
	// The Go collector comes with the default registry, and it is what turns
	// "the site feels slow" into an answer.
	require.Contains(t, exposition, "go_goroutines")
}

func TestServeReportsAPortAlreadyInUse(t *testing.T) {
	// A metrics endpoint that failed to bind and said nothing looks exactly
	// like a service with nothing to report.
	port := freePort(t)
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	require.NoError(t, err)
	defer listener.Close()

	require.ErrorContains(t, Serve(port), "listen")
}

func TestServeBindsBeforeItReturns(t *testing.T) {
	// The bind is synchronous on purpose: a scrape immediately after startup
	// must not race the listener into existence.
	port := freePort(t)
	require.NoError(t, Serve(port))

	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	require.NoError(t, err)
	require.NoError(t, conn.Close())
}
