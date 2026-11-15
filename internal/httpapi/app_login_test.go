package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const appVerifier = "verificador-do-app-com-bem-mais-de-quarenta-e-tres-caracteres"

func appChallengeOf(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func handoffCode(t *testing.T, w interface{ Header() http.Header }) string {
	t.Helper()
	done, err := url.Parse(w.Header().Get("Location"))
	require.NoError(t, err)
	require.Equal(t, AppLoginDonePath, done.Path)
	return done.Query().Get("code")
}

func TestAppLoginHandsTheBrowsersAccountToTheAppByCode(t *testing.T) {
	rig := newAccountRig(t, nil)
	_, browser := rig.signIn(t, "1", "Ana")

	start := rig.do(http.MethodGet, "/api/auth/app?challenge="+appChallengeOf(appVerifier), "", browser)
	require.Equal(t, http.StatusFound, start.Code)
	code := handoffCode(t, start)

	page := rig.do(http.MethodGet, AppLoginDonePath+"?code="+url.QueryEscape(code), "")
	require.Contains(t, page.Body.String(), `juntos://signed-in?code=`+url.QueryEscape(code))

	redeem := rig.do(http.MethodPost, "/api/auth/app/redeem", `{"code":"`+code+`","verifier":"`+appVerifier+`"}`)
	require.Equal(t, http.StatusNoContent, redeem.Code)
	app := cookieNamed(redeem, accountCookie)
	require.NotNil(t, app)
	require.NotEqual(t, browser.Value, app.Value, "o app ganha uma sessão própria")
	me := rig.do(http.MethodGet, "/api/me", "", app)
	require.Equal(t, http.StatusOK, me.Code)
	require.JSONEq(t, `"Ana"`, jsonField(t, me, "nickname"))

	again := rig.do(http.MethodPost, "/api/auth/app/redeem", `{"code":"`+code+`","verifier":"`+appVerifier+`"}`)
	require.Equal(t, http.StatusUnauthorized, again.Code, "o código vale uma vez só")
}

func TestAppLoginCodeIsWorthNothingWithoutItsVerifier(t *testing.T) {
	rig := newAccountRig(t, nil)
	_, browser := rig.signIn(t, "1", "Ana")
	code := handoffCode(t, rig.do(http.MethodGet, "/api/auth/app?challenge="+appChallengeOf(appVerifier), "", browser))

	stolen := rig.do(http.MethodPost, "/api/auth/app/redeem", `{"code":"`+code+`","verifier":"`+strings.Repeat("x", 50)+`"}`)

	require.Equal(t, http.StatusUnauthorized, stolen.Code)
	require.Nil(t, cookieNamed(stolen, accountCookie))
}

func TestAppLoginCodeExpires(t *testing.T) {
	clock := time.Now()
	handoffs := newAppHandoffs()
	handoffs.now = func() time.Time { return clock }
	handoffs.put("cedo", appHandoff{session: "s", challenge: "c", expires: clock.Add(appHandoffTTL)})
	handoffs.put("tarde", appHandoff{session: "s", challenge: "c", expires: clock.Add(appHandoffTTL)})

	_, ok := handoffs.take("cedo")
	require.True(t, ok)
	clock = clock.Add(appHandoffTTL + time.Second)
	_, ok = handoffs.take("tarde")
	require.False(t, ok)
}

func TestAppLoginWithoutAnAccountGoesThroughDiscordAndComesBack(t *testing.T) {
	rig := newAccountRig(t, nil)
	challenge := appChallengeOf(appVerifier)

	start := rig.do(http.MethodGet, "/api/auth/app?challenge="+challenge, "")

	require.Equal(t, http.StatusFound, start.Code)
	login, err := url.Parse(start.Header().Get("Location"))
	require.NoError(t, err)
	require.Equal(t, "/api/auth/discord", login.Path)
	require.Equal(t, "/api/auth/app?challenge="+challenge, login.Query().Get("next"))
	require.Equal(t, http.StatusBadRequest, rig.do(http.MethodGet, "/api/auth/app?challenge=curto", "").Code)
}
