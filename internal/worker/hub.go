package worker

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// The control plane's server end. Workers dial in over WSS; the first
// frame is a hello that either enrolls (one-shot secret) or proves the
// worker's key matches the one enrolled. From then on the link carries
// heartbeats up and signed jobs down, with results matched to jobs by id.

const (
	helloTimeout  = 15 * time.Second
	writeTimeout  = 10 * time.Second
	readTimeout   = 45 * time.Second
	helloSkew     = 2 * time.Minute
	resultTimeout = 120 * time.Second
	maxFrameBytes = 4 << 20
)

type hello struct {
	Type            string `json:"type"`
	WorkerID        string `json:"workerId"`
	PubKey          string `json:"pubkey"`
	Version         string `json:"version"`
	PublicBase      string `json:"publicBase"`
	TS              int64  `json:"ts"`
	Sig             string `json:"sig"`
	EnrollmentToken string `json:"enrollmentToken"`
}

// Result is a worker's answer to a job.
type Result struct {
	Type          string          `json:"type"`
	JobID         string          `json:"jobId"`
	Kind          string          `json:"kind"`
	OK            bool            `json:"ok"`
	Error         string          `json:"error"`
	Detail        string          `json:"detail"`
	Infohash      string          `json:"infohash"`
	Name          string          `json:"name"`
	Files         []FileEntry     `json:"files"`
	SelectedBytes int64           `json:"selectedBytes"`
	Raw           json.RawMessage `json:"-"`
}

// link is one connected worker.
type link struct {
	workerID string
	conn     *websocket.Conn
	send     chan []byte
	pending  map[string]chan Result
	mu       sync.Mutex
	closed   chan struct{}
	once     sync.Once
}

// Hub accepts worker links and routes jobs to them.
type Hub struct {
	registry *Registry
	signer   *Signer
	secret   string
	upgrader websocket.Upgrader
	onBeat   func(workerID string, hb Heartbeat)
}

func NewHub(registry *Registry, signer *Signer, enrollmentSecret string) *Hub {
	return &Hub{
		registry: registry,
		signer:   signer,
		secret:   enrollmentSecret,
		// Workers are not browsers: no Origin to check.
		upgrader: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
	}
}

// OnHeartbeat registers a callback for every heartbeat after the registry
// has recorded it.
func (h *Hub) OnHeartbeat(fn func(workerID string, hb Heartbeat)) {
	h.onBeat = fn
}

// Enabled is whether any worker could ever join.
func (h *Hub) Enabled() bool {
	return h.secret != ""
}

// HandleLink is the /ws/worker-link endpoint.
func (h *Hub) HandleLink(c *gin.Context) {
	if !h.Enabled() {
		c.Status(http.StatusNotFound)
		return
	}
	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	go h.serve(conn)
}

func (h *Hub) serve(conn *websocket.Conn) {
	ctx := context.Background()
	defer conn.Close()
	conn.SetReadLimit(maxFrameBytes)
	_ = conn.SetReadDeadline(time.Now().Add(helloTimeout))
	var hi hello
	if err := conn.ReadJSON(&hi); err != nil || hi.Type != "hello" {
		return
	}
	workerID, err := h.admit(ctx, hi)
	if err != nil {
		slog.Warn("worker link refused", "error", err, "worker", hi.WorkerID)
		_ = conn.WriteJSON(gin.H{"type": "reject", "error": err.Error()})
		return
	}
	l := &link{workerID: workerID, conn: conn, send: make(chan []byte, 64), pending: map[string]chan Result{}, closed: make(chan struct{})}
	h.registry.Attach(ctx, workerID, hi.PubKey, hi.PublicBase, l)
	defer h.registry.Detach(workerID, l)
	welcome, _ := json.Marshal(gin.H{"type": "welcome", "workerId": workerID, "serverPubkey": h.signer.PublicKeyB64()})
	_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	if err := conn.WriteMessage(websocket.TextMessage, welcome); err != nil {
		return
	}
	slog.Info("worker linked", "worker", workerID, "publicBase", hi.PublicBase, "version", hi.Version)
	go l.writer()
	defer l.close()
	for {
		_ = conn.SetReadDeadline(time.Now().Add(readTimeout))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			slog.Info("worker link closed", "worker", workerID, "error", err)
			return
		}
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &head) != nil {
			continue
		}
		switch head.Type {
		case "heartbeat":
			var hb Heartbeat
			if json.Unmarshal(raw, &hb) != nil {
				continue
			}
			if !h.registry.Observe(ctx, workerID, l, hb) {
				// A newer link took this identity over; this one is a zombie
				// and its numbers must not poison placement.
				return
			}
			if h.onBeat != nil {
				h.onBeat(workerID, hb)
			}
			// The worker treats a silent server as a dead link; every
			// heartbeat is answered so silence means what it says.
			select {
			case l.send <- []byte(`{"type":"ack"}`):
			default:
			}
		case "result":
			var result Result
			if json.Unmarshal(raw, &result) != nil {
				continue
			}
			result.Raw = raw
			l.deliver(result)
		}
	}
}

// admit decides who this is: an enrollment with the shared secret mints a
// worker id and binds the key; anyone else must sign as the key on file.
func (h *Hub) admit(ctx context.Context, hi hello) (string, error) {
	if hi.PubKey == "" || hi.Sig == "" {
		return "", errors.New("hello_incomplete")
	}
	now := time.Now().Unix()
	if hi.TS < now-int64(helloSkew.Seconds()) || hi.TS > now+int64(helloSkew.Seconds()) {
		return "", errors.New("hello_clock_skew")
	}
	if !VerifyHello(hi.PubKey, hi.WorkerID, hi.PublicBase, hi.TS, hi.Sig) {
		return "", errors.New("hello_signature")
	}
	if hi.WorkerID == "" {
		if hi.EnrollmentToken == "" || subtle.ConstantTimeCompare([]byte(hi.EnrollmentToken), []byte(h.secret)) != 1 {
			return "", errors.New("enrollment_refused")
		}
		id := "w_" + randomID(6)
		if err := h.registry.Enroll(ctx, id, hi.PubKey, hi.PublicBase); err != nil {
			return "", err
		}
		slog.Info("worker enrolled", "worker", id)
		return id, nil
	}
	known, err := h.registry.PubKey(ctx, hi.WorkerID)
	if err != nil {
		return "", err
	}
	if known == "" || subtle.ConstantTimeCompare([]byte(known), []byte(hi.PubKey)) != 1 {
		return "", errors.New("unknown_worker")
	}
	return hi.WorkerID, nil
}

func (l *link) writer() {
	for {
		select {
		case <-l.closed:
			return
		case msg := <-l.send:
			_ = l.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := l.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				l.close()
				return
			}
		}
	}
}

func (l *link) close() {
	l.once.Do(func() {
		close(l.closed)
		l.mu.Lock()
		for id, ch := range l.pending {
			close(ch)
			delete(l.pending, id)
		}
		l.mu.Unlock()
		_ = l.conn.Close()
	})
}

func (l *link) deliver(result Result) {
	l.mu.Lock()
	ch := l.pending[result.JobID]
	delete(l.pending, result.JobID)
	l.mu.Unlock()
	if ch != nil {
		ch <- result
		close(ch)
	}
}

// ErrWorkerGone is returned when the target worker is not linked here.
var ErrWorkerGone = errors.New("worker_gone")

// Dispatch signs a job, sends it, and waits for the result.
func (h *Hub) Dispatch(ctx context.Context, job Job, wait time.Duration) (Result, error) {
	l := h.registry.Link(job.WorkerID)
	if l == nil {
		return Result{}, ErrWorkerGone
	}
	env, err := h.signer.SignJob(job, 2*time.Minute)
	if err != nil {
		return Result{}, err
	}
	raw, _ := json.Marshal(env)
	ch := make(chan Result, 1)
	l.mu.Lock()
	l.pending[job.JobID] = ch
	l.mu.Unlock()
	select {
	case l.send <- raw:
	case <-l.closed:
		return Result{}, ErrWorkerGone
	case <-time.After(writeTimeout):
		l.mu.Lock()
		delete(l.pending, job.JobID)
		l.mu.Unlock()
		return Result{}, ErrWorkerGone
	}
	if wait <= 0 {
		wait = resultTimeout
	}
	select {
	case result, ok := <-ch:
		if !ok {
			return Result{}, ErrWorkerGone
		}
		return result, nil
	case <-l.closed:
		return Result{}, ErrWorkerGone
	case <-ctx.Done():
		return Result{}, ctx.Err()
	case <-time.After(wait):
		l.mu.Lock()
		delete(l.pending, job.JobID)
		l.mu.Unlock()
		return Result{}, errors.New("worker_timeout")
	}
}

// Send fires a job without waiting for its result.
func (h *Hub) Send(job Job) error {
	l := h.registry.Link(job.WorkerID)
	if l == nil {
		return ErrWorkerGone
	}
	env, err := h.signer.SignJob(job, 2*time.Minute)
	if err != nil {
		return err
	}
	raw, _ := json.Marshal(env)
	select {
	case l.send <- raw:
		return nil
	case <-l.closed:
		return ErrWorkerGone
	case <-time.After(writeTimeout):
		return ErrWorkerGone
	}
}
