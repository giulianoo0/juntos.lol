package discord

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// AuthorizeURL is the page where Discord asks the person to sign in.
const AuthorizeURL = "https://discord.com/oauth2/authorize"

// OAuth signs a person in with Discord's authorization code flow, asking
// only for who they are.
type OAuth struct {
	// Base is the REST API, e.g. https://discord.com/api/v10.
	Base         string
	ClientID     string
	ClientSecret string
	RedirectURI  string
	Client       *http.Client
}

// User is the slice of /users/@me an account is made from.
type User struct {
	ID         string `json:"id"`
	Username   string `json:"username"`
	GlobalName string `json:"global_name"`
}

// DisplayName is the name the person shows on Discord.
func (u User) DisplayName() string {
	if strings.TrimSpace(u.GlobalName) != "" {
		return u.GlobalName
	}
	return u.Username
}

// AuthorizeURL is where to send the browser, carrying the anti-forgery state.
func (o *OAuth) AuthorizeURL(state string) string {
	query := url.Values{
		"response_type": {"code"},
		"client_id":     {o.ClientID},
		"scope":         {"identify"},
		"redirect_uri":  {o.RedirectURI},
		"state":         {state},
		"prompt":        {"none"},
	}
	return AuthorizeURL + "?" + query.Encode()
}

// User trades the code for a token, reads who it belongs to and lets the
// token go: nothing is kept of it.
func (o *OAuth) User(ctx context.Context, code string) (User, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {o.RedirectURI},
		"client_id":     {o.ClientID},
		"client_secret": {o.ClientSecret},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, o.Base+"/oauth2/token", strings.NewReader(form.Encode()))
	if err != nil {
		return User{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := o.do(request, &token); err != nil {
		return User{}, fmt.Errorf("discord token: %w", err)
	}
	if token.AccessToken == "" {
		return User{}, errors.New("discord token: empty access token")
	}
	request, err = http.NewRequestWithContext(ctx, http.MethodGet, o.Base+"/users/@me", nil)
	if err != nil {
		return User{}, err
	}
	request.Header.Set("Authorization", "Bearer "+token.AccessToken)
	var user User
	if err := o.do(request, &user); err != nil {
		return User{}, fmt.Errorf("discord user: %w", err)
	}
	if user.ID == "" {
		return User{}, errors.New("discord user: no id")
	}
	return user, nil
}

func (o *OAuth) do(request *http.Request, into any) error {
	client := o.Client
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if response.StatusCode >= 300 {
		// The body of a refused exchange names the error, never the secret.
		return fmt.Errorf("%s: %s", response.Status, raw)
	}
	return json.Unmarshal(raw, into)
}
