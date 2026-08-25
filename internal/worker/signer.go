package worker

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// Signer holds the Ed25519 key every job envelope and every data-plane
// ticket is signed with. Workers learn the public half at enrollment and
// verify offline; the private half never leaves this process.
type Signer struct {
	key ed25519.PrivateKey
}

// LoadOrCreateSigner reads the seed from path, creating it when absent.
// An empty path means an ephemeral key.
func LoadOrCreateSigner(path string) (*Signer, error) {
	if path == "" {
		_, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
		return &Signer{key: key}, nil
	}
	raw, err := os.ReadFile(path)
	if err == nil {
		seed, err := hex.DecodeString(strings.TrimSpace(string(raw)))
		if err != nil || len(seed) != ed25519.SeedSize {
			return nil, fmt.Errorf("signing key file %s: not a %d-byte hex seed", path, ed25519.SeedSize)
		}
		return &Signer{key: ed25519.NewKeyFromSeed(seed)}, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(hex.EncodeToString(seed)+"\n"), 0o600); err != nil {
		return nil, err
	}
	return &Signer{key: ed25519.NewKeyFromSeed(seed)}, nil
}

// PublicKeyB64 is the verifying key, base64url without padding.
func (s *Signer) PublicKeyB64() string {
	return base64.RawURLEncoding.EncodeToString(s.key.Public().(ed25519.PublicKey))
}

// Job is what a worker is told to do. It names an infohash, never a URL,
// and the worker it is for; the nonce and expiry make it single-use.
type Job struct {
	Kind      string   `json:"kind"`
	JobID     string   `json:"jobId"`
	WorkerID  string   `json:"workerId"`
	Nonce     string   `json:"nonce"`
	Exp       int64    `json:"exp"`
	Infohash  string   `json:"infohash,omitempty"`
	FileIndex *int     `json:"fileIndex,omitempty"`
	RoomID    string   `json:"roomId,omitempty"`
	LeaseID   string   `json:"leaseId,omitempty"`
	Trackers  []string `json:"trackers,omitempty"`
	JTI       string   `json:"jti,omitempty"`
}

// Envelope is a signed job as it crosses the control link.
type Envelope struct {
	Type    string `json:"type"`
	Payload string `json:"payload"`
	Sig     string `json:"sig"`
}

// SignJob wraps a job in an envelope, filling nonce and expiry.
func (s *Signer) SignJob(job Job, ttl time.Duration) (Envelope, error) {
	if job.Nonce == "" {
		job.Nonce = randomID(16)
	}
	if job.Exp == 0 {
		job.Exp = time.Now().Add(ttl).Unix()
	}
	payload, err := json.Marshal(job)
	if err != nil {
		return Envelope{}, err
	}
	sig := ed25519.Sign(s.key, payload)
	return Envelope{
		Type:    "job",
		Payload: base64.RawURLEncoding.EncodeToString(payload),
		Sig:     base64.RawURLEncoding.EncodeToString(sig),
	}, nil
}

// Ticket is the data-plane credential a browser presents in the URL path.
type Ticket struct {
	RoomID    string `json:"room"`
	Infohash  string `json:"ih"`
	FileIndex int    `json:"file"`
	Audience  string `json:"aud"`
	WorkerID  string `json:"wid"`
	Exp       int64  `json:"exp"`
	JTI       string `json:"jti"`
}

// MintTicket signs a ticket: base64url(payload).base64url(sig).
func (s *Signer) MintTicket(t Ticket) (string, error) {
	if t.JTI == "" {
		t.JTI = randomID(12)
	}
	payload, err := json.Marshal(t)
	if err != nil {
		return "", err
	}
	sig := ed25519.Sign(s.key, payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// VerifyHello checks a worker's signature over its hello line. The public
// base is signed too: it is what every browser is later sent to, so a
// replayed hello must not be able to swap it.
func VerifyHello(pubkeyB64, workerID, publicBase string, ts int64, sigB64 string) bool {
	pub, err := base64.RawURLEncoding.DecodeString(pubkeyB64)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return false
	}
	message := fmt.Sprintf("hello|%s|%s|%s|%d", workerID, pubkeyB64, publicBase, ts)
	return ed25519.Verify(ed25519.PublicKey(pub), []byte(message), sig)
}

func randomID(n int) string {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw)
}
