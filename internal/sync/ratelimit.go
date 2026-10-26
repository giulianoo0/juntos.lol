package sync

import "time"

// rateRule is a token bucket: burst messages at once, then one more every
// interval.
type rateRule struct {
	burst int
	every time.Duration
}

// Types a person sends by hand get small buckets; the rest (ready reports,
// heartbeats, seeks while scrubbing) share a roomy default sized for the
// player's own cadence.
var (
	clientMessageRules = map[string]rateRule{
		"chat":         {burst: 8, every: time.Second},
		"stageRequest": {burst: 3, every: 10 * time.Second},
		"knock":        {burst: 2, every: 30 * time.Second},
	}
	defaultMessageRule = rateRule{burst: 40, every: 50 * time.Millisecond}
)

// A client names the type of each message, so it could open a bucket per
// made-up name; past this many the unknown names are refused.
const maxRateBuckets = 32

type rateBucket struct {
	tokens  float64
	last    time.Time
	refused bool
}

type rateDecision struct {
	ok bool
	// first marks the first refusal after an allowed message, so the client
	// hears about a flood once instead of once per dropped message.
	first bool
}

// rateLimiter belongs to one client and is used from its read loop only.
type rateLimiter struct {
	rules    map[string]rateRule
	fallback rateRule
	buckets  map[string]*rateBucket
}

func newRateLimiter(rules map[string]rateRule, fallback rateRule) *rateLimiter {
	return &rateLimiter{rules: rules, fallback: fallback, buckets: make(map[string]*rateBucket)}
}

func (l *rateLimiter) allow(kind string, now time.Time) rateDecision {
	rule, ok := l.rules[kind]
	if !ok {
		rule = l.fallback
	}
	bucket := l.buckets[kind]
	if bucket == nil {
		if len(l.buckets) >= maxRateBuckets {
			return rateDecision{}
		}
		bucket = &rateBucket{tokens: float64(rule.burst), last: now}
		l.buckets[kind] = bucket
	}
	if elapsed := now.Sub(bucket.last); elapsed > 0 {
		bucket.tokens = min(float64(rule.burst), bucket.tokens+float64(elapsed)/float64(rule.every))
		bucket.last = now
	}
	if bucket.tokens >= 1 {
		bucket.tokens--
		bucket.refused = false
		return rateDecision{ok: true}
	}
	first := !bucket.refused
	bucket.refused = true
	return rateDecision{first: first}
}
