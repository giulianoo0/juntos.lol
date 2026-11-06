package moqrelay

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/giulianoo0/ss/internal/room"
)

// fakeCloudflare keeps relays the way the MoQ API does, enough to watch
// what the rooms make and delete.
type fakeCloudflare struct {
	mu      sync.Mutex
	next    int
	relays  map[string]fakeRelay
	failing bool
}

type fakeRelay struct {
	name    string
	created time.Time
}

func (f *fakeCloudflare) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	reply := func(result any) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "errors": []any{}, "result": result})
	}
	path := strings.TrimPrefix(r.URL.Path, "/accounts/acct/moq/relays")
	switch {
	case f.failing:
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "errors": []any{map[string]any{"code": 1, "message": "down"}}})
	case r.Method == http.MethodPost && path == "":
		var body struct{ Name string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.next++
		uid := fmt.Sprintf("relay%d", f.next)
		f.relays[uid] = fakeRelay{name: body.Name, created: time.Now()}
		reply(map[string]any{"uid": uid, "name": body.Name, "issuers": []any{map[string]any{"cloudflare_tokens": []any{
			map[string]any{"operations": []string{"publish", "subscribe"}, "secret": "pub-" + uid},
			map[string]any{"operations": []string{"subscribe"}, "secret": "sub-" + uid},
		}}}})
	case r.Method == http.MethodDelete:
		uid := strings.TrimPrefix(path, "/")
		if _, ok := f.relays[uid]; !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		delete(f.relays, uid)
		reply(nil)
	case r.Method == http.MethodGet:
		listed := []any{}
		for uid, relay := range f.relays {
			listed = append(listed, map[string]any{"uid": uid, "name": relay.name, "created": relay.created})
		}
		reply(listed)
	default:
		w.WriteHeader(http.StatusBadRequest)
	}
}

func (f *fakeCloudflare) has(uid string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.relays[uid]
	return ok
}

func (f *fakeCloudflare) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.relays)
}

func (f *fakeCloudflare) age(uid string, by time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	relay := f.relays[uid]
	relay.created = relay.created.Add(-by)
	f.relays[uid] = relay
}

func setup(t *testing.T) (*Rooms, *room.Store, *fakeCloudflare) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	store := room.NewStore(rdb, time.Hour)
	cf := &fakeCloudflare{relays: map[string]fakeRelay{}}
	server := httptest.NewServer(http.HandlerFunc(cf.serve))
	t.Cleanup(server.Close)
	api := &API{Base: server.URL, Account: "acct", Token: "token", HTTP: server.Client()}
	return PerRoom("https://relay.example", "juntos.test", api, store), store, cf
}

func newRoom(t *testing.T, store *room.Store, id string) {
	t.Helper()
	err := store.Create(context.Background(), &room.Room{ID: id, Status: room.StatusEmpty, CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
}

func TestEveryRoomGetsARelayOfItsOwnOnce(t *testing.T) {
	rooms, store, cf := setup(t)
	ctx := context.Background()
	newRoom(t, store, "AAAA")
	newRoom(t, store, "BBBB")

	var wg sync.WaitGroup
	got := make([]Relay, 8)
	for i := range got {
		wg.Add(1)
		go func() {
			defer wg.Done()
			relay, err := rooms.ForRoom(ctx, "AAAA")
			if err != nil {
				t.Error(err)
			}
			got[i] = relay
		}()
	}
	wg.Wait()
	for _, relay := range got[1:] {
		if relay != got[0] {
			t.Fatalf("members of one room got different relays: %+v and %+v", got[0], relay)
		}
	}
	other, err := rooms.ForRoom(ctx, "BBBB")
	if err != nil {
		t.Fatal(err)
	}
	if other.Subscribe == got[0].Subscribe || other.Publish == got[0].Publish {
		t.Fatalf("two rooms share tokens: %+v", other)
	}
	if got[0].SubscribeURL() != "https://relay.example/"+got[0].Subscribe {
		t.Fatalf("subscribe url = %q", got[0].SubscribeURL())
	}
	if cf.count() != 2 {
		t.Fatalf("relays made = %d, want one per room", cf.count())
	}
}

func TestAKickMovesTheRoomToANewRelayAndDropsTheOld(t *testing.T) {
	rooms, store, cf := setup(t)
	ctx := context.Background()
	newRoom(t, store, "AAAA")
	before, err := rooms.ForRoom(ctx, "AAAA")
	if err != nil {
		t.Fatal(err)
	}
	moved, err := rooms.Rotate(ctx, "AAAA")
	if err != nil || !moved {
		t.Fatalf("rotate = %v, %v", moved, err)
	}
	after, err := rooms.ForRoom(ctx, "AAAA")
	if err != nil {
		t.Fatal(err)
	}
	if after.Subscribe == before.Subscribe || after.Epoch != before.Epoch+1 {
		t.Fatalf("relay before %+v, after %+v", before, after)
	}
	if cf.has(strings.TrimPrefix(before.Subscribe, "sub-")) {
		t.Fatal("the relay the room left is still there")
	}
	stored, err := store.Get(ctx, "AAAA")
	if err != nil || stored.RelayEpoch != after.Epoch {
		t.Fatalf("room says epoch %d, want %d (%v)", stored.RelayEpoch, after.Epoch, err)
	}
}

func TestARoomsFirstRelayLeavesItsEpochAlone(t *testing.T) {
	rooms, store, _ := setup(t)
	ctx := context.Background()
	newRoom(t, store, "AAAA")
	first, err := rooms.ForRoom(ctx, "AAAA")
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := store.Get(ctx, "AAAA")
	if first.Epoch != 0 || stored.RelayEpoch != 0 {
		t.Fatalf("a fresh room's relay moved its epoch: relay %d, room %d", first.Epoch, stored.RelayEpoch)
	}
}

func TestAKickKeepsTryingWhileCloudflareRefuses(t *testing.T) {
	rooms, store, cf := setup(t)
	ctx := context.Background()
	newRoom(t, store, "AAAA")
	before, _ := rooms.ForRoom(ctx, "AAAA")
	cf.mu.Lock()
	cf.failing = true
	cf.mu.Unlock()
	time.AfterFunc(350*time.Millisecond, func() {
		cf.mu.Lock()
		cf.failing = false
		cf.mu.Unlock()
	})
	moveRetryFirst = 100 * time.Millisecond
	t.Cleanup(func() { moveRetryFirst = 2 * time.Second })
	moved := 0
	rooms.MoveAfterKick(ctx, "AAAA", func() { moved++ })
	after, _ := rooms.ForRoom(ctx, "AAAA")
	if moved != 1 || after.Subscribe == before.Subscribe {
		t.Fatalf("moved %d times, relay %+v -> %+v", moved, before, after)
	}

	gone := 0
	rooms.MoveAfterKick(ctx, "NOROOM", func() { gone++ })
	if gone != 0 {
		t.Fatal("a room that ended was moved")
	}
}

func TestARoomWithoutARelayHasNothingToMove(t *testing.T) {
	rooms, store, cf := setup(t)
	newRoom(t, store, "AAAA")
	moved, err := rooms.Rotate(context.Background(), "AAAA")
	if err != nil || moved || cf.count() != 0 {
		t.Fatalf("rotate = %v, %v with %d relays", moved, err, cf.count())
	}
}

func TestARoomWithoutARelayToGiveSharesNoneOther(t *testing.T) {
	rooms, store, cf := setup(t)
	newRoom(t, store, "AAAA")
	cf.failing = true
	if _, err := rooms.ForRoom(context.Background(), "AAAA"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	if _, err := rooms.ForRoom(context.Background(), "GONE"); !errors.Is(err, room.ErrNotFound) {
		t.Fatalf("missing room: err = %v", err)
	}
}

func TestTheSweeperKeepsOnlyTheRelaysRoomsAreOn(t *testing.T) {
	rooms, store, cf := setup(t)
	ctx := context.Background()
	newRoom(t, store, "LIVE")
	newRoom(t, store, "GONE")
	live, _ := rooms.ForRoom(ctx, "LIVE")
	gone, _ := rooms.ForRoom(ctx, "GONE")
	liveUID, goneUID := strings.TrimPrefix(live.Subscribe, "sub-"), strings.TrimPrefix(gone.Subscribe, "sub-")
	if err := store.Delete(ctx, "GONE"); err != nil {
		t.Fatal(err)
	}
	stray, err := rooms.api.Create(ctx, rooms.prefix+"LIVE")
	if err != nil {
		t.Fatal(err)
	}
	foreign, _ := rooms.api.Create(ctx, "someone-elses")
	otherServer, _ := rooms.api.Create(ctx, NamePrefix("127.0.0.1")+"GONE")
	fresh, _ := rooms.api.Create(ctx, rooms.prefix+"NEWROOM")
	for _, uid := range []string{liveUID, goneUID, stray.UID, foreign.UID, otherServer.UID} {
		cf.age(uid, time.Hour)
	}

	if err := rooms.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	for uid, want := range map[string]bool{liveUID: true, goneUID: false, stray.UID: false, foreign.UID: true, otherServer.UID: true, fresh.UID: true} {
		if cf.has(uid) != want {
			t.Errorf("relay %s kept = %v, want %v", uid, cf.has(uid), want)
		}
	}
}

func TestTheSharedRelayIsTheSameForEveryRoom(t *testing.T) {
	rooms := Shared("https://relay.example", "pub", "sub")
	a, _ := rooms.ForRoom(context.Background(), "AAAA")
	b, _ := rooms.ForRoom(context.Background(), "BBBB")
	if a != b || a.PublishURL() != "https://relay.example/pub" {
		t.Fatalf("shared relays %+v %+v", a, b)
	}
}

func TestABridgeTicketCarriesTheRoomSigned(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	raw := BridgeURL("/moq-bridge", "0123456789abcdef0123456789abcdef", "juntos/ROOM/secret", "https://relay.example/sub", now)
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Path != "/moq-bridge" {
		t.Fatalf("bridge url %q: %v", raw, err)
	}
	payload, sig, ok := strings.Cut(parsed.Query().Get("t"), ".")
	if !ok {
		t.Fatalf("ticket %q", parsed.Query().Get("t"))
	}
	mac := hmac.New(sha256.New, []byte("0123456789abcdef0123456789abcdef"))
	mac.Write([]byte(payload))
	if base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) != sig {
		t.Fatal("ticket signature does not match")
	}
	body, _ := base64.RawURLEncoding.DecodeString(payload)
	var ticket struct {
		B, U string
		E    int64
	}
	if err := json.Unmarshal(body, &ticket); err != nil {
		t.Fatal(err)
	}
	if ticket.B != "juntos/ROOM/secret" || ticket.U != "https://relay.example/sub" || ticket.E != now.Add(TicketTTL).Unix() {
		t.Fatalf("ticket = %+v", ticket)
	}
}

func TestAPublishTicketNamesTheOnePathItMayWrite(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	secret := "0123456789abcdef0123456789abcdef"
	decode := func(raw string) map[string]any {
		parsed, _ := url.Parse(raw)
		payload, _, _ := strings.Cut(parsed.Query().Get("t"), ".")
		body, _ := base64.RawURLEncoding.DecodeString(payload)
		var ticket map[string]any
		if err := json.Unmarshal(body, &ticket); err != nil {
			t.Fatal(err)
		}
		return ticket
	}
	ticket := decode(BridgePublishURL("/moq-bridge", secret, "juntos/ROOM/secret", "https://relay.example/sub", "https://relay.example/pub", "juntos/ROOM/secret/m2.hang", now))
	if ticket["p"] != "https://relay.example/pub" || ticket["w"] != "juntos/ROOM/secret/m2.hang" || ticket["b"] != "juntos/ROOM/secret" {
		t.Fatalf("publish ticket = %+v", ticket)
	}
	watching := decode(BridgeURL("/moq-bridge", secret, "juntos/ROOM/secret", "https://relay.example/sub", now))
	if _, ok := watching["p"]; ok {
		t.Fatalf("a watch ticket carries a publish token: %+v", watching)
	}
}
