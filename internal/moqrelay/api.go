package moqrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/giulianoo0/ss/internal/room"
)

// API is the slice of Cloudflare's MoQ API the rooms need. Its token should
// carry MoQ Read and Write on the one account and nothing else.
type API struct {
	Base    string
	Account string
	Token   string
	HTTP    *http.Client
}

// NewAPI talks to api.cloudflare.com.
func NewAPI(account, token string) *API {
	return &API{
		Base:    "https://api.cloudflare.com/client/v4",
		Account: account,
		Token:   token,
		HTTP:    &http.Client{Timeout: 15 * time.Second},
	}
}

type envelope struct {
	Success    bool            `json:"success"`
	Errors     []apiError      `json:"errors"`
	Result     json.RawMessage `json:"result"`
	ResultInfo *struct {
		TotalPages int `json:"total_pages"`
	} `json:"result_info"`
}

// errGone is a relay that no longer exists.
var errGone = errors.New("moq relay not found")

type apiError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (a *API) call(ctx context.Context, method, path string, body any) (envelope, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return envelope{}, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.Base+"/accounts/"+a.Account+"/moq/relays"+path, reader)
	if err != nil {
		return envelope{}, err
	}
	req.Header.Set("Authorization", "Bearer "+a.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := a.HTTP.Do(req)
	if err != nil {
		return envelope{}, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return envelope{}, errGone
	}
	var out envelope
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil {
		return envelope{}, fmt.Errorf("moq api %s %s: %d, unreadable body: %w", method, path, res.StatusCode, err)
	}
	if !out.Success || res.StatusCode >= 300 {
		return envelope{}, fmt.Errorf("moq api %s %s: %d %v", method, path, res.StatusCode, out.Errors)
	}
	return out, nil
}

// Create makes a relay and keeps the two tokens it is born with.
func (a *API) Create(ctx context.Context, name string) (room.Relay, error) {
	out, err := a.call(ctx, http.MethodPost, "", map[string]string{"name": name})
	if err != nil {
		return room.Relay{}, err
	}
	var made struct {
		UID     string `json:"uid"`
		Issuers []struct {
			Tokens []struct {
				Operations []string `json:"operations"`
				Secret     string   `json:"secret"`
			} `json:"cloudflare_tokens"`
		} `json:"issuers"`
	}
	if err := json.Unmarshal(out.Result, &made); err != nil {
		return room.Relay{}, fmt.Errorf("moq api create: %w", err)
	}
	relay := room.Relay{UID: made.UID}
	for _, issuer := range made.Issuers {
		for _, token := range issuer.Tokens {
			switch {
			case slices.Contains(token.Operations, "publish"):
				relay.Publish = token.Secret
			case slices.Contains(token.Operations, "subscribe"):
				relay.Subscribe = token.Secret
			}
		}
	}
	if relay.UID == "" || relay.Publish == "" || relay.Subscribe == "" {
		// A relay we cannot use still counts against the account.
		_ = a.Delete(context.WithoutCancel(ctx), relay.UID)
		return room.Relay{}, fmt.Errorf("moq api create: relay %q came without its tokens", made.UID)
	}
	return relay, nil
}

// Delete removes a relay. One already gone is not an error.
func (a *API) Delete(ctx context.Context, uid string) error {
	if uid == "" {
		return nil
	}
	_, err := a.call(ctx, http.MethodDelete, "/"+uid, nil)
	if errors.Is(err, errGone) {
		return nil
	}
	return err
}

// Listed is a relay as the account lists it.
type Listed struct {
	UID     string
	Name    string
	Created time.Time
}

// List returns every relay on the account.
func (a *API) List(ctx context.Context) ([]Listed, error) {
	var all []Listed
	for page := 1; ; page++ {
		out, err := a.call(ctx, http.MethodGet, "?per_page=100&page="+strconv.Itoa(page), nil)
		if err != nil {
			return nil, err
		}
		var relays []struct {
			UID     string    `json:"uid"`
			Name    string    `json:"name"`
			Created time.Time `json:"created"`
		}
		if err := json.Unmarshal(out.Result, &relays); err != nil {
			return nil, fmt.Errorf("moq api list: %w", err)
		}
		for _, relay := range relays {
			all = append(all, Listed{UID: relay.UID, Name: relay.Name, Created: relay.Created})
		}
		if out.ResultInfo == nil || page >= out.ResultInfo.TotalPages || len(relays) == 0 {
			return all, nil
		}
	}
}
