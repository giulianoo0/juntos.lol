// rangefixture is a dev-only HTTP Range server with fault injection. It
// stands in for a remote ss-worker: it serves one local file over Range
// requests and lets the caller dial in the failure modes the real worker
// will exhibit over a WAN — latency, jitter, capped responses, bodies that
// end early, 5xx blips, mid-body stalls — so the browser pipeline can be
// hardened against them before any worker exists.
//
// Every knob is an environment variable so the same binary drives both the
// fault harness and the throughput rig:
//
//	FILE          path of the file to serve (required)
//	ADDR          listen address (default :8099)
//	TLS           1 → self-signed TLS with h2 (browsers need --ignore-certificate-errors)
//	RTT_MS        sleep before the first body byte of every response
//	JITTER_MS     random extra sleep, applied between body chunks
//	CHUNK_BYTES   body write size (default 64 KiB)
//	CAP_BYTES     honest per-response cap: Content-Range shrinks to match
//	TRUNCATE_PCT  % of 206s whose body ends early while Content-Range promised more
//	ERR_5XX_PCT   % of requests answered with 503
//	STALL_PCT     % of 206s that stall mid-body
//	STALL_MS      how long a stall lasts; after it the body ends early (like the worker)
//	STALL_FOREVER 1 → a stalled body never ends (the pathological case)
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"io"
	"log"
	"math/big"
	mathrand "math/rand/v2"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

type knobs struct {
	file         string
	addr         string
	tls          bool
	rtt          time.Duration
	jitter       time.Duration
	chunk        int64
	cap          int64
	truncatePct  int
	err5xxPct    int
	stallPct     int
	stall        time.Duration
	stallForever bool
}

func envInt(name string, def int64) int64 {
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		log.Fatalf("%s: %v", name, err)
	}
	return n
}

func loadKnobs() knobs {
	k := knobs{
		file:         os.Getenv("FILE"),
		addr:         os.Getenv("ADDR"),
		tls:          os.Getenv("TLS") == "1",
		rtt:          time.Duration(envInt("RTT_MS", 0)) * time.Millisecond,
		jitter:       time.Duration(envInt("JITTER_MS", 0)) * time.Millisecond,
		chunk:        envInt("CHUNK_BYTES", 64*1024),
		cap:          envInt("CAP_BYTES", 0),
		truncatePct:  int(envInt("TRUNCATE_PCT", 0)),
		err5xxPct:    int(envInt("ERR_5XX_PCT", 0)),
		stallPct:     int(envInt("STALL_PCT", 0)),
		stall:        time.Duration(envInt("STALL_MS", 0)) * time.Millisecond,
		stallForever: os.Getenv("STALL_FOREVER") == "1",
	}
	if k.file == "" {
		log.Fatal("FILE is required")
	}
	if k.addr == "" {
		k.addr = ":8099"
	}
	return k
}

type fixture struct {
	k        knobs
	size     int64
	requests atomic.Int64
}

func (f *fixture) cors(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		origin = "*"
	}
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", origin)
	h.Set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Range, Content-Type")
	h.Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
	h.Set("Accept-Ranges", "bytes")
}

// parseRange handles the single-range form the pipeline emits. RFC 9110: an
// end past the size is clamped; a start at or past the size is unsatisfiable.
func (f *fixture) parseRange(spec string) (start, end int64, ok bool) {
	if !strings.HasPrefix(spec, "bytes=") {
		return 0, 0, false
	}
	parts := strings.SplitN(strings.TrimPrefix(spec, "bytes="), "-", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	if parts[0] == "" {
		n, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, false
		}
		return max(f.size-n, 0), f.size - 1, true
	}
	s, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || s < 0 || s >= f.size {
		return 0, 0, false
	}
	e := f.size - 1
	if parts[1] != "" {
		e, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || e < s {
			return 0, 0, false
		}
		e = min(e, f.size-1)
	}
	return s, e, true
}

func (f *fixture) serve(w http.ResponseWriter, r *http.Request) {
	f.cors(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	n := f.requests.Add(1)
	if f.k.err5xxPct > 0 && mathrand.IntN(100) < f.k.err5xxPct {
		log.Printf("#%d %s → 503 (injected)", n, r.Header.Get("Range"))
		http.Error(w, "injected", http.StatusServiceUnavailable)
		return
	}
	spec := r.Header.Get("Range")
	if spec == "" {
		w.Header().Set("Content-Length", strconv.FormatInt(f.size, 10))
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			f.stream(w, r, 0, f.size-1, n)
		}
		return
	}
	start, end, ok := f.parseRange(spec)
	if !ok {
		w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(f.size, 10))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	// The honest cap: the response promises exactly what it will deliver, and
	// the client is expected to ask for the rest.
	if f.k.cap > 0 && end-start+1 > f.k.cap {
		end = start + f.k.cap - 1
	}
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, f.size))
	w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	w.WriteHeader(http.StatusPartialContent)
	if r.Method == http.MethodHead {
		return
	}
	f.stream(w, r, start, end, n)
}

// stream writes [start, end] in chunks, applying RTT, jitter, truncation and
// stalls. A body that ends early does so by returning — the connection is
// left healthy, exactly like a worker that gave up on a piece.
func (f *fixture) stream(w http.ResponseWriter, r *http.Request, start, end, n int64) {
	src, err := os.Open(f.k.file)
	if err != nil {
		log.Printf("#%d open: %v", n, err)
		return
	}
	defer src.Close()
	total := end - start + 1
	cutAt := int64(-1)
	if f.k.truncatePct > 0 && mathrand.IntN(100) < f.k.truncatePct && total > 1 {
		cutAt = mathrand.Int64N(total)
	}
	stallAt := int64(-1)
	if f.k.stallPct > 0 && mathrand.IntN(100) < f.k.stallPct && total > 1 {
		stallAt = mathrand.Int64N(total)
	}
	if f.k.rtt > 0 {
		time.Sleep(f.k.rtt)
	}
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, f.k.chunk)
	var sent int64
	began := time.Now()
	for sent < total {
		if cutAt >= 0 && sent >= cutAt {
			log.Printf("#%d bytes %d-%d: truncated after %d/%d (injected)", n, start, end, sent, total)
			return
		}
		if stallAt >= 0 && sent >= stallAt {
			if f.k.stallForever {
				log.Printf("#%d bytes %d-%d: stalling forever after %d/%d (injected)", n, start, end, sent, total)
				<-r.Context().Done()
				return
			}
			log.Printf("#%d bytes %d-%d: stalling %s after %d/%d then ending early (injected)", n, start, end, f.k.stall, sent, total)
			select {
			case <-time.After(f.k.stall):
			case <-r.Context().Done():
			}
			return
		}
		want := min(int64(len(buf)), total-sent)
		read, err := src.ReadAt(buf[:want], start+sent)
		if err != nil && err != io.EOF {
			log.Printf("#%d read: %v", n, err)
			return
		}
		if read == 0 {
			return
		}
		if _, err := w.Write(buf[:read]); err != nil {
			log.Printf("#%d bytes %d-%d: client went away after %d/%d", n, start, end, sent, total)
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
		sent += int64(read)
		if f.k.jitter > 0 {
			time.Sleep(time.Duration(mathrand.Int64N(int64(f.k.jitter))))
		}
	}
	elapsed := time.Since(began)
	if elapsed > 0 {
		log.Printf("#%d bytes %d-%d: %d B in %s (%.1f Mbit/s)", n, start, end, total, elapsed.Round(time.Millisecond),
			float64(total)*8/elapsed.Seconds()/1e6)
	}
}

func selfSigned() tls.Certificate {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "rangefixture"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		log.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func main() {
	k := loadKnobs()
	info, err := os.Stat(k.file)
	if err != nil {
		log.Fatal(err)
	}
	f := &fixture{k: k, size: info.Size()}
	mux := http.NewServeMux()
	mux.HandleFunc("/f", f.serve)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		f.cors(w, r)
		fmt.Fprintf(w, `{"size":%d,"requests":%d}`, f.size, f.requests.Load())
	})
	srv := &http.Server{Addr: k.addr, Handler: mux}
	log.Printf("rangefixture: %s (%d bytes) on %s tls=%v rtt=%s jitter=%s cap=%d truncate=%d%% 5xx=%d%% stall=%d%%/%s",
		k.file, f.size, k.addr, k.tls, k.rtt, k.jitter, k.cap, k.truncatePct, k.err5xxPct, k.stallPct, k.stall)
	if k.tls {
		srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{selfSigned()}, NextProtos: []string{"h2", "http/1.1"}}
		log.Fatal(srv.ListenAndServeTLS("", ""))
	}
	log.Fatal(srv.ListenAndServe())
}
