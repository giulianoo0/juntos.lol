package urlingest

import (
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCheckURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want error
	}{
		{"plain https", "https://cdn.example.com/movie.mkv", nil},
		{"http", "http://cdn.example.com/movie.mkv", ErrScheme},
		{"file", "file:///etc/passwd", ErrScheme},
		{"no host", "https:///movie.mkv", ErrBadURL},
		{"credentials", "https://user:pass@cdn.example.com/m.mkv", ErrBadURL},
		{"localhost", "https://localhost/movie.mkv", ErrPrivateAddress},
		{"localhost suffix", "https://api.localhost/movie.mkv", ErrPrivateAddress},
		{"loopback", "https://127.0.0.1/movie.mkv", ErrPrivateAddress},
		{"loopback v6", "https://[::1]/movie.mkv", ErrPrivateAddress},
		{"rfc1918 10", "https://10.0.0.5/movie.mkv", ErrPrivateAddress},
		{"rfc1918 172", "https://172.16.3.4/movie.mkv", ErrPrivateAddress},
		{"rfc1918 192", "https://192.168.1.9/movie.mkv", ErrPrivateAddress},
		{"link local", "https://169.254.169.254/latest/meta-data", ErrPrivateAddress},
		{"unique local v6", "https://[fd00::1]/movie.mkv", ErrPrivateAddress},
		{"cgnat", "https://100.100.1.1/movie.mkv", ErrPrivateAddress},
		{"this network", "https://0.1.2.3/movie.mkv", ErrPrivateAddress},
		{"nat64", "https://[64:ff9b::a00:1]/movie.mkv", ErrPrivateAddress},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := CheckURL(test.raw)
			if test.want == nil {
				if err != nil {
					t.Fatalf("CheckURL(%q) = %v, want nil", test.raw, err)
				}
				return
			}
			if !errors.Is(err, test.want) {
				t.Fatalf("CheckURL(%q) = %v, want %v", test.raw, err, test.want)
			}
		})
	}
}

func TestCheckAddr(t *testing.T) {
	if err := CheckAddr("tcp4", "93.184.216.34:443"); err != nil {
		t.Fatalf("public address refused: %v", err)
	}
	for _, addr := range []string{
		"127.0.0.1:443", "10.1.2.3:443", "169.254.169.254:80", "[::1]:443",
		"100.100.1.1:443", "198.18.0.1:443", "255.255.255.255:443",
		"[64:ff9b::a00:1]:443", "0.0.0.0:443", "[fd00::1]:443",
	} {
		if err := CheckAddr("tcp", addr); !errors.Is(err, ErrPrivateAddress) {
			t.Fatalf("CheckAddr(%q) = %v, want ErrPrivateAddress", addr, err)
		}
	}
}

// The test that matters, and the one a guard in the wrong place passes by
// accident: an ordinary hostname, resolved by the client itself, landing on a
// private address. `localhost` is the one name every machine has.
func TestSafeClientRefusesANameThatResolvesToLoopback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	_, port, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatalf("split test server address: %v", err)
	}
	// http, not https: CheckURL is not what is under test here, the dialer is.
	request, err := http.NewRequest(http.MethodGet, "http://localhost:"+port+"/", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if _, err := SafeClient(5 * time.Second).Do(request); err == nil {
		t.Fatal("expected the dial to be refused")
	} else if !strings.Contains(err.Error(), ErrPrivateAddress.Error()) {
		t.Fatalf("err = %v, want it to mention %v", err, ErrPrivateAddress)
	}
}

// The other half, and it has to go through a real client: without it, a guard
// that refused every address would pass the test above and look correct.
// httptest has no public address to offer, so the dialer's gate is swapped for
// a permissive one — what is under test is that SafeClient dials at all.
func TestSafeClientDialsWhenTheGateAllows(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "reached")
	}))
	defer server.Close()

	client := SafeClient(5 * time.Second)
	client.Transport.(*http.Transport).DialContext = (&net.Dialer{}).DialContext

	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("dial refused with a permissive gate: %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if string(body) != "reached" {
		t.Fatalf("body = %q, want \"reached\"", body)
	}
}
