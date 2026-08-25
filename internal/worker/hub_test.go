package worker

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"
)

func t0ctx() context.Context { return context.Background() }

// fakeWorker speaks the worker's side of the control link.
type fakeWorker struct {
	conn *websocket.Conn
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
}

func dialWorker(t *testing.T, url string) *fakeWorker {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })
	return &fakeWorker{conn: conn, pub: pub, priv: priv}
}

func (w *fakeWorker) hello(workerID, token string) map[string]any {
	pubB64 := base64.RawURLEncoding.EncodeToString(w.pub)
	ts := time.Now().Unix()
	sig := ed25519.Sign(w.priv, []byte(fmt.Sprintf("hello|%s|%s|%d", workerID, pubB64, ts)))
	msg := map[string]any{"type": "hello", "workerId": workerID, "pubkey": pubB64, "version": "test", "publicBase": "https://w.test", "ts": ts, "sig": base64.RawURLEncoding.EncodeToString(sig)}
	if token != "" {
		msg["enrollmentToken"] = token
	}
	return msg
}

func (w *fakeWorker) read(t *testing.T) map[string]any {
	t.Helper()
	_ = w.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var msg map[string]any
	require.NoError(t, w.conn.ReadJSON(&msg))
	return msg
}

func newHubServer(t *testing.T, secret string) (*Hub, *Registry, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	registry := newRegistry(t)
	signer, err := LoadOrCreateSigner("")
	require.NoError(t, err)
	hub := NewHub(registry, signer, secret)
	r := gin.New()
	r.GET("/ws/worker-link", hub.HandleLink)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return hub, registry, "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/worker-link"
}

func TestEnrollHeartbeatDispatch(t *testing.T) {
	hub, registry, url := newHubServer(t, "s3cret")
	w := dialWorker(t, url)
	require.NoError(t, w.conn.WriteJSON(w.hello("", "s3cret")))
	welcome := w.read(t)
	require.Equal(t, "welcome", welcome["type"])
	workerID := welcome["workerId"].(string)
	require.True(t, strings.HasPrefix(workerID, "w_"))
	require.Equal(t, hub.signer.PublicKeyB64(), welcome["serverPubkey"])

	// A heartbeat lands in the registry and is acked.
	require.NoError(t, w.conn.WriteJSON(map[string]any{"type": "heartbeat", "ready": true, "maxLeases": 4, "publicBase": "https://w.test"}))
	require.Equal(t, "ack", w.read(t)["type"])
	require.Eventually(t, func() bool {
		got, ok := registry.Get(workerID)
		return ok && got.Heartbeat.Ready
	}, 2*time.Second, 10*time.Millisecond)

	// A dispatched job arrives signed; the result is routed back by id.
	done := make(chan Result, 1)
	go func() {
		res, err := hub.Dispatch(t0ctx(), Job{Kind: "lease", JobID: "j1", WorkerID: workerID, Infohash: strings.Repeat("a", 40), LeaseID: "l1"}, 5*time.Second)
		require.NoError(t, err)
		done <- res
	}()
	frame := w.read(t)
	require.Equal(t, "job", frame["type"])
	payload, err := base64.RawURLEncoding.DecodeString(frame["payload"].(string))
	require.NoError(t, err)
	sig, err := base64.RawURLEncoding.DecodeString(frame["sig"].(string))
	require.NoError(t, err)
	serverPub, _ := base64.RawURLEncoding.DecodeString(hub.signer.PublicKeyB64())
	require.True(t, ed25519.Verify(ed25519.PublicKey(serverPub), payload, sig))
	var job Job
	require.NoError(t, json.Unmarshal(payload, &job))
	require.Equal(t, workerID, job.WorkerID)
	require.NoError(t, w.conn.WriteJSON(map[string]any{"type": "result", "jobId": "j1", "kind": "lease", "ok": true, "name": "Show", "files": []map[string]any{{"index": 0, "name": "e1.mkv", "path": "Show/e1.mkv", "size": 100}}}))
	select {
	case res := <-done:
		require.True(t, res.OK)
		require.Equal(t, "Show", res.Name)
		require.Len(t, res.Files, 1)
	case <-time.After(5 * time.Second):
		t.Fatal("no result")
	}

	// Reconnecting as the enrolled worker needs the same key, no token.
	w.conn.Close()
	again := &fakeWorker{pub: w.pub, priv: w.priv}
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	require.NoError(t, err)
	defer conn.Close()
	again.conn = conn
	require.NoError(t, conn.WriteJSON(again.hello(workerID, "")))
	require.Equal(t, "welcome", again.read(t)["type"])
}

func TestHubRefusals(t *testing.T) {
	_, _, url := newHubServer(t, "s3cret")
	w := dialWorker(t, url)
	require.NoError(t, w.conn.WriteJSON(w.hello("", "wrong")))
	msg := w.read(t)
	require.Equal(t, "reject", msg["type"])
	require.Equal(t, "enrollment_refused", msg["error"])

	other := dialWorker(t, url)
	require.NoError(t, other.conn.WriteJSON(other.hello("w_unknown", "")))
	msg = other.read(t)
	require.Equal(t, "reject", msg["type"])
	require.Equal(t, "unknown_worker", msg["error"])

	// A hello signed by a different key than it presents.
	forged := dialWorker(t, url)
	h := forged.hello("", "s3cret")
	h["sig"] = base64.RawURLEncoding.EncodeToString(make([]byte, 64))
	require.NoError(t, forged.conn.WriteJSON(h))
	require.Equal(t, "hello_signature", forged.read(t)["error"])
}

func TestHubDisabledWithoutSecret(t *testing.T) {
	hub, _, url := newHubServer(t, "")
	require.False(t, hub.Enabled())
	_, resp, err := websocket.DefaultDialer.Dial(url, nil)
	require.Error(t, err)
	require.Equal(t, 404, resp.StatusCode)
}
