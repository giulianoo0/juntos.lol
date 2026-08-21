package upload

import (
	"sync"
	"time"
)

// settleGrace is how long a finished upload is remembered so that a straggling
// progress event cannot reopen its account.
//
// tusd emits one last progress message when the request context ends, and that
// send races the completion message: they travel on separate channels, read by
// separate goroutines. Losing the race means the completion is handled first,
// and a forgotten upload would then look like a brand new one holding the
// whole file — which is exactly how the counter came to read twice the bytes
// that were actually uploaded.
const settleGrace = time.Minute

// account is one upload's position, and whether it has already been closed.
type account struct {
	offset   int64
	closedAt time.Time
}

// receivedBytes turns the tus store's offsets into something a counter can be
// fed.
//
// Progress arrives as "this upload now holds N bytes", twice a second, per
// upload — a position, not an amount. A Prometheus counter needs the
// difference between two of them and must never be handed a negative one, and
// there are three ways that would otherwise happen: an upload resumed after a
// broken connection reports an offset the store had already confirmed, ticks
// can arrive out of order, and the last one can arrive after the upload is
// already finished.
//
// Taking the difference from the store's own confirmed offset rather than from
// the bytes on the wire is deliberate. A chunk sent twice is bandwidth spent,
// but it is not a byte the room received, and the number this feeds is how
// much media arrived.
type receivedBytes struct {
	mu       sync.Mutex
	accounts map[string]*account
	// now is the clock, so the test does not have to wait out settleGrace.
	now func() time.Time
}

func newReceivedBytes() *receivedBytes {
	return &receivedBytes{accounts: make(map[string]*account), now: time.Now}
}

// advance reports how many bytes this upload gained since it was last seen.
// An upload that has already been settled gained nothing: its total is final.
func (r *receivedBytes) advance(uploadID string, offset int64) int64 {
	if uploadID == "" {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	open, exists := r.accounts[uploadID]
	if exists && !open.closedAt.IsZero() {
		return 0
	}
	if !exists {
		open = &account{}
		r.accounts[uploadID] = open
	}
	gained := offset - open.offset
	if gained <= 0 {
		return 0
	}
	open.offset = offset
	return gained
}

// settle closes an upload's account and reports whatever the progress ticks
// never got to.
//
// It is what keeps the counter whole: an upload that finishes inside a single
// tick interval, which is every small file, produces no progress event at all
// and would otherwise be counted as zero bytes.
func (r *receivedBytes) settle(uploadID string, offset int64) int64 {
	if uploadID == "" {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	r.pruneLocked(now)
	open, exists := r.accounts[uploadID]
	if exists && !open.closedAt.IsZero() {
		return 0
	}
	if !exists {
		open = &account{}
		r.accounts[uploadID] = open
	}
	gained := offset - open.offset
	open.closedAt = now
	if gained <= 0 {
		return 0
	}
	open.offset = offset
	return gained
}

// pruneLocked drops accounts closed long enough ago that nothing can still be
// in flight for them. Without it the map would hold an entry for every upload
// the process ever served.
func (r *receivedBytes) pruneLocked(now time.Time) {
	for id, open := range r.accounts {
		if !open.closedAt.IsZero() && now.Sub(open.closedAt) > settleGrace {
			delete(r.accounts, id)
		}
	}
}

// tracked reports how many uploads are still being accounted for. It exists
// for the test that holds this to releasing them.
func (r *receivedBytes) tracked() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.accounts)
}
