package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/discord"
	"github.com/giulianoo0/ss/internal/room"
	syncapi "github.com/giulianoo0/ss/internal/sync"
)

const (
	accountCookie    = "ss_account"
	oauthStateCookie = "ss_oauth"
	oauthStateTTL    = 10 * time.Minute
	maxNextBytes     = 512
	maxAccountBody   = 4 << 10
	historyPageSize  = 50

	// loginCallbacksPerHour caps sign-in attempts per client address, and
	// friendRequestsPerHour the asks one account may send.
	loginCallbacksPerHour = 30
	friendRequestsPerHour = 30
	// profileReadsPerHour caps profile and history reads per client address,
	// so the sequential numbers can't be walked in one go.
	profileReadsPerHour = 600
)

// PresenceSource says which room each account is in right now.
type PresenceSource interface {
	Presence(accountIDs []int64) map[int64]string
}

// WithAccounts mounts sign-in with Discord, the account, friends and history.
func WithAccounts(accounts *account.Store) ServerOption {
	return func(o *serverOptions) { o.accounts = accounts }
}

type accountRoutes struct {
	cfg       config.Config
	accounts  *account.Store
	rooms     *room.Store
	presence  PresenceSource
	login     *discord.OAuth
	callbacks *windowLimiter
	asks      *windowLimiter
	reads     *windowLimiter
}

// RegisterAccountRoutes mounts the account API. Without a Discord secret the
// two login routes answer 503 and nobody can sign in; the rest still answers.
func RegisterAccountRoutes(rg *gin.RouterGroup, cfg config.Config, accounts *account.Store, rooms *room.Store, presence PresenceSource) {
	routes := &accountRoutes{
		cfg: cfg, accounts: accounts, rooms: rooms, presence: presence,
		callbacks: newWindowLimiter(loginCallbacksPerHour, time.Hour),
		asks:      newWindowLimiter(friendRequestsPerHour, time.Hour),
		reads:     newWindowLimiter(profileReadsPerHour, time.Hour),
	}
	if cfg.DiscordLoginEnabled() {
		routes.login = &discord.OAuth{
			Base: cfg.DiscordAPIBase, ClientID: cfg.DiscordClientID, ClientSecret: cfg.DiscordClientSecret,
			RedirectURI: cfg.DiscordRedirectURI(), Client: &http.Client{Timeout: 10 * time.Second},
		}
	}
	rg.GET("/auth/discord", routes.startLogin)
	rg.GET("/auth/discord/callback", routes.finishLogin)
	rg.Use(routes.sameOrigin)
	rg.POST("/auth/logout", routes.logout)
	rg.GET("/me", routes.me)
	rg.PATCH("/me", routes.patchMe)
	rg.GET("/friends", routes.friends)
	rg.DELETE("/friends/:id", routes.removeFriend)
	rg.GET("/friends/requests", routes.friendRequests)
	rg.POST("/friends/requests", routes.requestFriend)
	rg.POST("/friends/requests/:id/accept", routes.acceptFriend)
	rg.DELETE("/friends/requests/:id", routes.removeFriend)
	rg.GET("/users/:id", routes.profile)
	rg.GET("/users/:id/history", routes.history)
}

// HubAccounts is what the hub signs sockets in with and keeps watches through.
func HubAccounts(accounts *account.Store) syncapi.Accounts {
	return hubAccounts{accounts: accounts}
}

type hubAccounts struct{ accounts *account.Store }

func (h hubAccounts) Identify(r *http.Request) (syncapi.Identity, bool) {
	cookie, err := r.Cookie(accountCookie)
	if err != nil {
		return syncapi.Identity{}, false
	}
	id, err := h.accounts.SessionAccount(r.Context(), cookie.Value)
	if err != nil || id == 0 {
		return syncapi.Identity{}, false
	}
	signed, err := h.accounts.Get(r.Context(), id)
	if err != nil {
		return syncapi.Identity{}, false
	}
	return syncapi.Identity{AccountID: signed.ID, Avatar: signed.Avatar, Unlisted: signed.Visibility == account.VisibilityPrivate}, true
}

func (h hubAccounts) RecordWatch(ctx context.Context, accountID int64, watch account.Watch) error {
	return h.accounts.RecordWatch(ctx, accountID, watch)
}

func (a *accountRoutes) secureCookie(r *http.Request) bool {
	return strings.HasPrefix(a.cfg.PublicOrigin, "https://") || secureRequest(r)
}

func (a *accountRoutes) startLogin(c *gin.Context) {
	if a.login == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "accounts_disabled"})
		return
	}
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	state := base64.RawURLEncoding.EncodeToString(raw)
	next := base64.RawURLEncoding.EncodeToString([]byte(safeNext(c.Query("next"))))
	http.SetCookie(c.Writer, &http.Cookie{
		Name: oauthStateCookie, Value: state + "." + next, Path: "/api/auth/",
		MaxAge: int(oauthStateTTL / time.Second), HttpOnly: true, Secure: a.secureCookie(c.Request),
		SameSite: http.SameSiteLaxMode,
	})
	c.Redirect(http.StatusFound, a.login.AuthorizeURL(state))
}

func (a *accountRoutes) finishLogin(c *gin.Context) {
	if a.login == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "accounts_disabled"})
		return
	}
	if !a.callbacks.allow(requestIP(c.Request, a.cfg.BehindCloudflare)) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too_many_logins"})
		return
	}
	http.SetCookie(c.Writer, &http.Cookie{Name: oauthStateCookie, Value: "", Path: "/api/auth/", MaxAge: -1,
		HttpOnly: true, Secure: a.secureCookie(c.Request), SameSite: http.SameSiteLaxMode})
	stored, _ := c.Cookie(oauthStateCookie)
	want, encodedNext, _ := strings.Cut(stored, ".")
	got := c.Query("state")
	if want == "" || len(want) != len(got) || subtle.ConstantTimeCompare([]byte(want), []byte(got)) != 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad_state"})
		return
	}
	nextBytes, _ := base64.RawURLEncoding.DecodeString(encodedNext)
	next := safeNext(string(nextBytes))
	code := c.Query("code")
	if code == "" {
		// The person said no on Discord's page.
		c.Redirect(http.StatusFound, next)
		return
	}
	ctx := c.Request.Context()
	user, err := a.login.User(ctx, code)
	if err != nil {
		slog.WarnContext(ctx, "discord login failed", "error", err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "discord_failed"})
		return
	}
	signed, err := a.accounts.SignInDiscord(ctx, user.ID, user.DisplayName())
	if err != nil {
		slog.ErrorContext(ctx, "sign in account", "error", err)
		c.Status(http.StatusInternalServerError)
		return
	}
	token, err := a.accounts.StartSession(ctx, signed.ID)
	if err != nil {
		slog.ErrorContext(ctx, "start account session", "error", err)
		c.Status(http.StatusInternalServerError)
		return
	}
	http.SetCookie(c.Writer, &http.Cookie{
		Name: accountCookie, Value: token, Path: "/", MaxAge: int((30 * 24 * time.Hour) / time.Second),
		HttpOnly: true, Secure: a.secureCookie(c.Request), SameSite: http.SameSiteLaxMode,
	})
	c.Redirect(http.StatusFound, next)
}

// safeNext keeps a same-site path to come back to, and turns anything that
// could leave the site into "/".
func safeNext(next string) string {
	if next == "" || len(next) > maxNextBytes || !strings.HasPrefix(next, "/") ||
		strings.HasPrefix(next, "//") || strings.ContainsAny(next, "\\\r\n\t") {
		return "/"
	}
	parsed, err := url.Parse(next)
	if err != nil || parsed.Scheme != "" || parsed.Host != "" {
		return "/"
	}
	return next
}

func (a *accountRoutes) logout(c *gin.Context) {
	if cookie, err := c.Cookie(accountCookie); err == nil {
		if err := a.accounts.EndSession(c.Request.Context(), cookie); err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
	}
	http.SetCookie(c.Writer, &http.Cookie{Name: accountCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: a.secureCookie(c.Request), SameSite: http.SameSiteLaxMode})
	c.Status(http.StatusNoContent)
}

// viewer is who the request is signed in as; ok is false for nobody, in
// which case the response has already been written when required is set.
func (a *accountRoutes) viewer(c *gin.Context, required bool) (account.Account, bool) {
	cookie, err := c.Cookie(accountCookie)
	if err == nil {
		id, err := a.accounts.SessionAccount(c.Request.Context(), cookie)
		if err != nil {
			c.AbortWithStatus(http.StatusInternalServerError)
			return account.Account{}, false
		}
		if id != 0 {
			signed, err := a.accounts.Get(c.Request.Context(), id)
			if err == nil {
				return signed, true
			}
			if !errors.Is(err, account.ErrNotFound) {
				c.AbortWithStatus(http.StatusInternalServerError)
				return account.Account{}, false
			}
		}
	}
	if required {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "not_signed_in"})
	}
	return account.Account{}, false
}

type accountCard struct {
	ID       int64  `json:"id"`
	Nickname string `json:"nickname"`
	Avatar   string `json:"avatar"`
}

type accountStats struct {
	Sessions int64   `json:"sessions"`
	Hours    float64 `json:"hours"`
	Friends  int64   `json:"friends"`
}

func cardOf(a account.Account) accountCard {
	return accountCard{ID: a.ID, Nickname: a.Nickname, Avatar: a.Avatar}
}

func (a *accountRoutes) stats(ctx context.Context, of account.Account) (accountStats, error) {
	friends, err := a.accounts.FriendCount(ctx, of.ID)
	return accountStats{
		Sessions: of.Sessions,
		Hours:    math.Round(float64(of.WatchedSeconds)/360) / 10,
		Friends:  friends,
	}, err
}

func (a *accountRoutes) writeMe(c *gin.Context, me account.Account) {
	stats, err := a.stats(c.Request.Context(), me)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"id": me.ID, "nickname": me.Nickname, "avatar": me.Avatar, "visibility": me.Visibility,
		"createdAt": me.CreatedAt, "stats": stats,
	})
}

func (a *accountRoutes) me(c *gin.Context) {
	me, ok := a.viewer(c, true)
	if !ok {
		return
	}
	a.writeMe(c, me)
}

func (a *accountRoutes) patchMe(c *gin.Context) {
	me, ok := a.viewer(c, true)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAccountBody)
	var changes account.Changes
	if err := c.ShouldBindJSON(&changes); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	updated, err := a.accounts.Update(c.Request.Context(), me.ID, changes)
	if errors.Is(err, account.ErrInvalid) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_account"})
		return
	}
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	a.writeMe(c, updated)
}

// lookup fetches each account once, skipping the ones gone. seen carries
// what earlier calls already fetched.
func (a *accountRoutes) lookup(ctx context.Context, ids []int64, seen map[int64]*account.Account) ([]account.Account, error) {
	found := make([]account.Account, 0, len(ids))
	for _, id := range ids {
		cached, known := seen[id]
		if !known {
			got, err := a.accounts.Get(ctx, id)
			if err != nil && !errors.Is(err, account.ErrNotFound) {
				return nil, err
			}
			if err == nil {
				cached = &got
			}
			seen[id] = cached
		}
		if cached != nil {
			found = append(found, *cached)
		}
	}
	return found, nil
}

// cards looks up how each account shows up, skipping the ones gone.
func (a *accountRoutes) cards(ctx context.Context, ids []int64) ([]accountCard, error) {
	found, err := a.lookup(ctx, ids, map[int64]*account.Account{})
	if err != nil {
		return nil, err
	}
	cards := make([]accountCard, 0, len(found))
	for _, each := range found {
		cards = append(cards, cardOf(each))
	}
	return cards, nil
}

// sameOrigin turns away a change sent from a page that isn't the site: the
// SameSite cookie already stops other sites, this also stops a sibling host.
func (a *accountRoutes) sameOrigin(c *gin.Context) {
	switch c.Request.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return
	}
	origin := c.GetHeader("Origin")
	if origin != "" && a.cfg.PublicOrigin != "" && origin != a.cfg.PublicOrigin {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "bad_origin"})
	}
}

type friendPresence struct {
	InRoom bool `json:"inRoom"`
	// RoomID is only shown for a room anyone may walk into.
	RoomID string `json:"roomId,omitempty"`
}

type friendCard struct {
	accountCard
	Presence friendPresence `json:"presence"`
}

func (a *accountRoutes) friends(c *gin.Context) {
	me, ok := a.viewer(c, true)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	ids, err := a.accounts.Friends(ctx, me.ID)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	found, err := a.lookup(ctx, ids, map[int64]*account.Account{})
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	var present map[int64]string
	if a.presence != nil {
		present = a.presence.Presence(ids)
	}
	openRooms := map[string]bool{}
	friends := make([]friendCard, 0, len(found))
	for _, each := range found {
		friend := friendCard{accountCard: cardOf(each)}
		// A private account shows no presence, not even to friends.
		if roomID, here := present[each.ID]; here && each.Visibility != account.VisibilityPrivate {
			friend.Presence.InRoom = true
			open, known := openRooms[roomID]
			if !known {
				stored, err := a.rooms.Get(ctx, roomID)
				open = err == nil && joinModeOf(stored) == room.JoinOpen
				openRooms[roomID] = open
			}
			if open {
				friend.Presence.RoomID = roomID
			}
		}
		friends = append(friends, friend)
	}
	c.JSON(http.StatusOK, gin.H{"friends": friends})
}

func (a *accountRoutes) friendRequests(c *gin.Context) {
	me, ok := a.viewer(c, true)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	incomingIDs, outgoingIDs, err := a.accounts.FriendRequests(ctx, me.ID)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	incoming, err := a.cards(ctx, incomingIDs)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	outgoing, err := a.cards(ctx, outgoingIDs)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.JSON(http.StatusOK, gin.H{"incoming": incoming, "outgoing": outgoing})
}

func (a *accountRoutes) requestFriend(c *gin.Context) {
	me, ok := a.viewer(c, true)
	if !ok {
		return
	}
	if !a.asks.allow(strconv.FormatInt(me.ID, 10)) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too_many_requests"})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAccountBody)
	var request struct {
		ID int64 `json:"id"`
	}
	if err := c.ShouldBindJSON(&request); err != nil || request.ID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	state, err := a.accounts.RequestFriend(c.Request.Context(), me.ID, request.ID)
	switch {
	case errors.Is(err, account.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "user_not_found"})
	case errors.Is(err, account.ErrInvalid):
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_friend"})
	case err != nil:
		c.Status(http.StatusInternalServerError)
	default:
		c.JSON(http.StatusOK, gin.H{"state": state})
	}
}

func (a *accountRoutes) acceptFriend(c *gin.Context) {
	me, ok := a.viewer(c, true)
	if !ok {
		return
	}
	from, ok := accountIDParam(c)
	if !ok {
		return
	}
	err := a.accounts.AcceptFriend(c.Request.Context(), me.ID, from)
	switch {
	case errors.Is(err, account.ErrNoRequest):
		c.JSON(http.StatusNotFound, gin.H{"error": "request_not_found"})
	case err != nil:
		c.Status(http.StatusInternalServerError)
	default:
		c.Status(http.StatusNoContent)
	}
}

// removeFriend ends a friendship, or withdraws or declines a request.
func (a *accountRoutes) removeFriend(c *gin.Context) {
	me, ok := a.viewer(c, true)
	if !ok {
		return
	}
	other, ok := accountIDParam(c)
	if !ok {
		return
	}
	if err := a.accounts.RemoveFriend(c.Request.Context(), me.ID, other); err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.Status(http.StatusNoContent)
}

func accountIDParam(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "user_not_found"})
		return 0, false
	}
	return id, true
}

// visibleTo answers whether the viewer may see an account's counters and
// history: anyone for public, friends for friends, only its owner for private.
func (a *accountRoutes) visibleTo(ctx context.Context, owner account.Account, viewer account.Account, signed bool) (bool, error) {
	if signed && viewer.ID == owner.ID {
		return true, nil
	}
	switch owner.Visibility {
	case account.VisibilityPublic:
		return true, nil
	case account.VisibilityFriends:
		if !signed {
			return false, nil
		}
		return a.accounts.AreFriends(ctx, owner.ID, viewer.ID)
	default:
		return false, nil
	}
}

// subject is the account named in the path, with whether the viewer may see
// past its card. A response is already written when ok is false.
func (a *accountRoutes) subject(c *gin.Context) (owner, viewer account.Account, signed, visible, ok bool) {
	if !a.reads.allow(requestIP(c.Request, a.cfg.BehindCloudflare)) {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too_many_requests"})
		return account.Account{}, account.Account{}, false, false, false
	}
	id, ok := accountIDParam(c)
	if !ok {
		return account.Account{}, account.Account{}, false, false, false
	}
	ctx := c.Request.Context()
	owner, err := a.accounts.Get(ctx, id)
	if errors.Is(err, account.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "user_not_found"})
		return account.Account{}, account.Account{}, false, false, false
	}
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return account.Account{}, account.Account{}, false, false, false
	}
	viewer, signed = a.viewer(c, false)
	if c.IsAborted() {
		return account.Account{}, account.Account{}, false, false, false
	}
	visible, err = a.visibleTo(ctx, owner, viewer, signed)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return account.Account{}, account.Account{}, false, false, false
	}
	// A private account is not there for whoever may not see it.
	if !visible && owner.Visibility == account.VisibilityPrivate {
		c.JSON(http.StatusNotFound, gin.H{"error": "user_not_found"})
		return account.Account{}, account.Account{}, false, false, false
	}
	return owner, viewer, signed, visible, true
}

func (a *accountRoutes) profile(c *gin.Context) {
	owner, _, _, visible, ok := a.subject(c)
	if !ok {
		return
	}
	if !visible {
		c.JSON(http.StatusOK, cardOf(owner))
		return
	}
	stats, err := a.stats(c.Request.Context(), owner)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": owner.ID, "nickname": owner.Nickname, "avatar": owner.Avatar, "stats": stats})
}

type historyEntry struct {
	// RoomID is only shown to the account's owner.
	RoomID      string        `json:"roomId,omitempty"`
	Title       string        `json:"title"`
	Kind        string        `json:"kind"`
	StartedAt   time.Time     `json:"startedAt"`
	DurationSec int64         `json:"durationSec"`
	With        []accountCard `json:"with"`
}

func (a *accountRoutes) history(c *gin.Context) {
	owner, viewer, signed, visible, ok := a.subject(c)
	if !ok {
		return
	}
	self := signed && viewer.ID == owner.ID
	if !visible {
		c.JSON(http.StatusForbidden, gin.H{"error": "history_hidden"})
		return
	}
	ctx := c.Request.Context()
	watches, err := a.accounts.History(ctx, owner.ID, historyPageSize)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}
	seen := map[int64]*account.Account{}
	shown := map[int64]bool{}
	entries := make([]historyEntry, 0, len(watches))
	for _, watch := range watches {
		companions, err := a.lookup(ctx, watch.With, seen)
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		// Who was there is each companion's own to show: someone whose
		// history the viewer may not see is left out of this one too.
		with := make([]accountCard, 0, len(companions))
		for _, companion := range companions {
			visible, known := shown[companion.ID]
			if !known {
				visible, err = a.visibleTo(ctx, companion, viewer, signed)
				if err != nil {
					c.Status(http.StatusInternalServerError)
					return
				}
				shown[companion.ID] = visible
			}
			if visible {
				with = append(with, cardOf(companion))
			}
		}
		entry := historyEntry{Title: watch.Title, Kind: watch.Kind, StartedAt: watch.StartedAt,
			DurationSec: watch.DurationSec, With: with}
		if self {
			entry.RoomID = watch.RoomID
		}
		entries = append(entries, entry)
	}
	c.JSON(http.StatusOK, gin.H{"history": entries})
}
