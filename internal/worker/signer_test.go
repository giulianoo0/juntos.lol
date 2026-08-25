package worker

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestSignerPersistsAndSigns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "key")
	a, err := LoadOrCreateSigner(path)
	require.NoError(t, err)
	b, err := LoadOrCreateSigner(path)
	require.NoError(t, err)
	require.Equal(t, a.PublicKeyB64(), b.PublicKeyB64(), "same file, same key")

	pub, err := base64.RawURLEncoding.DecodeString(a.PublicKeyB64())
	require.NoError(t, err)

	env, err := a.SignJob(Job{Kind: "lease", JobID: "j1", WorkerID: "w1", Infohash: strings.Repeat("a", 40)}, time.Minute)
	require.NoError(t, err)
	payload, _ := base64.RawURLEncoding.DecodeString(env.Payload)
	sig, _ := base64.RawURLEncoding.DecodeString(env.Sig)
	require.True(t, ed25519.Verify(ed25519.PublicKey(pub), payload, sig))
	var job Job
	require.NoError(t, json.Unmarshal(payload, &job))
	require.NotEmpty(t, job.Nonce)
	require.Greater(t, job.Exp, time.Now().Unix())

	ticket, err := a.MintTicket(Ticket{RoomID: "r", Infohash: strings.Repeat("b", 40), Audience: "https://x", WorkerID: "w1", Exp: time.Now().Add(time.Minute).Unix()})
	require.NoError(t, err)
	parts := strings.SplitN(ticket, ".", 2)
	require.Len(t, parts, 2)
	tp, _ := base64.RawURLEncoding.DecodeString(parts[0])
	ts, _ := base64.RawURLEncoding.DecodeString(parts[1])
	require.True(t, ed25519.Verify(ed25519.PublicKey(pub), tp, ts))
}

func TestVerifyHello(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	pubB64 := base64.RawURLEncoding.EncodeToString(pub)
	ts := time.Now().Unix()
	message := "hello|w1|" + pubB64 + "|" + itoa(ts)
	sig := base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, []byte(message)))
	require.True(t, VerifyHello(pubB64, "w1", ts, sig))
	require.False(t, VerifyHello(pubB64, "w2", ts, sig))
	require.False(t, VerifyHello(pubB64, "w1", ts+1, sig))
}

func itoa(n int64) string {
	raw, _ := json.Marshal(n)
	return string(raw)
}
