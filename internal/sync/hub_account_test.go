package sync

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	stdsync "sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/config"
)

// cookieAccounts signs a socket in as the number in its "acct" cookie and
// keeps every watch it is told about.
type cookieAccounts struct {
	mu      stdsync.Mutex
	watches map[int64][]account.Watch
}

func (a *cookieAccounts) Identify(r *http.Request) (Identity, bool) {
	cookie, err := r.Cookie("acct")
	if err != nil {
		return Identity{}, false
	}
	id, _ := strconv.ParseInt(cookie.Value, 10, 64)
	return Identity{AccountID: id, Avatar: "fox.bowtie"}, id > 0
}

func (a *cookieAccounts) RecordWatch(_ context.Context, id int64, watch account.Watch) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.watches == nil {
		a.watches = map[int64][]account.Watch{}
	}
	a.watches[id] = append(a.watches[id], watch)
	return nil
}

func (a *cookieAccounts) of(id int64) []account.Watch {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]account.Watch(nil), a.watches[id]...)
}

func dialAs(t *testing.T, server *httptest.Server, accountID int64) *websocket.Conn {
	t.Helper()
	serverURL, err := url.Parse(server.URL)
	require.NoError(t, err)
	serverURL.Scheme = "ws"
	serverURL.Path = "/ws/rooms/r1"
	header := http.Header{}
	if accountID > 0 {
		header.Set("Cookie", "acct="+strconv.FormatInt(accountID, 10))
	}
	conn, response, err := websocket.DefaultDialer.Dial(serverURL.String(), header)
	if response != nil {
		defer response.Body.Close()
	}
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func newAccountHub(t *testing.T) (*Hub, *cookieAccounts, *httptest.Server) {
	t.Helper()
	previous := minWatch
	minWatch = 0
	t.Cleanup(func() { minWatch = previous })
	hub, _, server := newHubTestServer(t, config.Config{})
	accounts := &cookieAccounts{}
	hub.SetAccounts(accounts)
	return hub, accounts, server
}

func TestHubShowsWhichAccountAMemberIs(t *testing.T) {
	_, _, server := newAccountHub(t)
	signed := dialAs(t, server, 7)
	helloHubClient(t, signed, "ana", 1)
	guest := dialAs(t, server, 0)
	welcome := helloHubClient(t, guest, "visita", 2)

	require.Len(t, welcome.Members, 2)
	require.Equal(t, int64(7), welcome.Members[0].AccountID)
	require.Equal(t, "fox.bowtie", welcome.Members[0].Avatar)
	require.Zero(t, welcome.Members[1].AccountID, "visita sem conta segue anônima")
}

func TestHubPresenceFollowsSignedInMembers(t *testing.T) {
	hub, _, server := newAccountHub(t)
	ana := dialAs(t, server, 1)
	helloHubClient(t, ana, "ana", 1)
	bia := dialAs(t, server, 2)
	helloHubClient(t, bia, "bia", 2)

	require.Equal(t, map[int64]string{1: "r1", 2: "r1"}, hub.Presence([]int64{1, 2, 3}))

	require.NoError(t, ana.Close())
	require.Eventually(t, func() bool {
		_, here := hub.Presence([]int64{1})[1]
		return !here
	}, 2*time.Second, 10*time.Millisecond)
	require.Equal(t, map[int64]string{2: "r1"}, hub.Presence([]int64{1, 2}))
}

func TestHubRecordsWhatAMemberWatchedWhenTheyLeave(t *testing.T) {
	_, accounts, server := newAccountHub(t)
	ana := dialAs(t, server, 1)
	helloHubClient(t, ana, "ana", 1)
	bia := dialAs(t, server, 2)
	helloHubClient(t, bia, "bia", 2)
	guest := dialAs(t, server, 0)
	helloHubClient(t, guest, "visita", 3)

	require.NoError(t, bia.Close())
	require.Eventually(t, func() bool { return len(accounts.of(2)) == 1 }, 2*time.Second, 10*time.Millisecond)

	watch := accounts.of(2)[0]
	require.Equal(t, "r1", watch.RoomID)
	require.Equal(t, "movie.mkv", watch.Title)
	require.Equal(t, []int64{1}, watch.With, "só contas entram no junto, a visita não")
	require.Empty(t, accounts.of(1), "quem ficou ainda não fechou a sessão")
}

func TestHubClosesEveryonesWatchWhenTheMediaChanges(t *testing.T) {
	hub, accounts, server := newAccountHub(t)
	store := hub.store
	ana := dialAs(t, server, 1)
	helloHubClient(t, ana, "ana", 1)
	bia := dialAs(t, server, 2)
	helloHubClient(t, bia, "bia", 2)

	_, _, err := store.SwapSource(t.Context(), "r1", "m1", "outro.mkv", "uploading", time.Now())
	require.NoError(t, err)
	hub.ResetPlayback("r1")

	require.Eventually(t, func() bool { return len(accounts.of(1)) == 1 && len(accounts.of(2)) == 1 },
		2*time.Second, 10*time.Millisecond)
	require.Equal(t, "movie.mkv", accounts.of(1)[0].Title, "a sessão fechada é da mídia que saiu")
	require.Equal(t, []int64{2}, accounts.of(1)[0].With)

	require.NoError(t, ana.Close())
	require.Eventually(t, func() bool { return len(accounts.of(1)) == 2 }, 2*time.Second, 10*time.Millisecond)
	require.Equal(t, "outro.mkv", accounts.of(1)[1].Title)
}
