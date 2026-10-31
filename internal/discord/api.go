package discord

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// API is the slice of Discord's REST API the card needs: channel messages
// through the bot, and follow-ups through an interaction's token.
type API struct {
	// Base is e.g. https://discord.com/api/v10.
	Base     string
	AppID    string
	BotToken string
	Client   *http.Client
}

func (a *API) CreateChannelMessage(ctx context.Context, channelID string, message any) (string, error) {
	return a.call(ctx, http.MethodPost, "/channels/"+url.PathEscape(channelID)+"/messages", true, message)
}

func (a *API) EditChannelMessage(ctx context.Context, channelID, messageID string, message any) error {
	_, err := a.call(ctx, http.MethodPatch, "/channels/"+url.PathEscape(channelID)+"/messages/"+url.PathEscape(messageID), true, message)
	return err
}

func (a *API) CreateFollowup(ctx context.Context, token string, message any) (string, error) {
	return a.call(ctx, http.MethodPost, "/webhooks/"+url.PathEscape(a.AppID)+"/"+url.PathEscape(token), false, message)
}

func (a *API) EditFollowup(ctx context.Context, token, messageID string, message any) error {
	_, err := a.call(ctx, http.MethodPatch, "/webhooks/"+url.PathEscape(a.AppID)+"/"+url.PathEscape(token)+"/messages/"+url.PathEscape(messageID), false, message)
	return err
}

// AddGuildMember puts a signed-in person in the server with the role, through
// the guilds.join token of their sign-in. Someone already there keeps their
// place and just gains the role, which the join alone would not give them.
func (a *API) AddGuildMember(ctx context.Context, guildID, userID, accessToken, roleID string) error {
	member := map[string]any{"access_token": accessToken}
	if roleID != "" {
		member["roles"] = []string{roleID}
	}
	path := "/guilds/" + url.PathEscape(guildID) + "/members/" + url.PathEscape(userID)
	if _, err := a.call(ctx, http.MethodPut, path, true, member); err != nil {
		return err
	}
	if roleID == "" {
		return nil
	}
	return a.AddGuildMemberRole(ctx, guildID, userID, roleID)
}

// AddGuildMemberRole gives someone already in the server the role, through
// the bot alone.
func (a *API) AddGuildMemberRole(ctx context.Context, guildID, userID, roleID string) error {
	_, err := a.call(ctx, http.MethodPut, "/guilds/"+url.PathEscape(guildID)+"/members/"+url.PathEscape(userID)+"/roles/"+url.PathEscape(roleID), true, struct{}{})
	return err
}

// IsGuildMember says whether the user is in the server, as the bot sees it.
func (a *API) IsGuildMember(ctx context.Context, guildID, userID string) (bool, error) {
	_, err := a.call(ctx, http.MethodGet, "/guilds/"+url.PathEscape(guildID)+"/members/"+url.PathEscape(userID), true, nil)
	var refused *APIError
	if errors.As(err, &refused) && refused.StatusCode == http.StatusNotFound {
		return false, nil
	}
	return err == nil, err
}

// ErrDMClosed is Discord refusing the bot a DM: the person shares no server
// with the app, hasn't installed it, or turned DMs off.
var ErrDMClosed = errors.New("discord dm closed")

// codeCannotMessageUser is Discord's "Cannot send messages to this user".
const codeCannotMessageUser = 50007

// SendDM opens the bot's DM with a Discord user and posts the message there.
func (a *API) SendDM(ctx context.Context, userID string, message any) error {
	channelID, err := a.call(ctx, http.MethodPost, "/users/@me/channels", true, map[string]any{"recipient_id": userID})
	if err == nil {
		_, err = a.CreateChannelMessage(ctx, channelID, message)
	}
	var refused *APIError
	if errors.As(err, &refused) && (refused.Code == codeCannotMessageUser || refused.StatusCode == http.StatusForbidden) {
		return ErrDMClosed
	}
	return err
}

// APIError is Discord answering a call with an error status.
type APIError struct {
	Method     string
	StatusCode int
	Status     string
	// Code is Discord's JSON error code, 0 when the body had none.
	Code int
	Body string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("discord %s: %s: %s", e.Method, e.Status, e.Body)
}

func (a *API) call(ctx context.Context, method, path string, asBot bool, message any) (string, error) {
	var body io.Reader
	if message != nil {
		raw, err := json.Marshal(message)
		if err != nil {
			return "", fmt.Errorf("marshal discord message: %w", err)
		}
		body = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, method, a.Base+path, body)
	if err != nil {
		return "", err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if asBot {
		request.Header.Set("Authorization", "Bot "+a.BotToken)
	}
	client := a.Client
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		// The path and the URL in a *url.Error carry the interaction token.
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return "", fmt.Errorf("discord %s: %w", method, err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if response.StatusCode >= 300 {
		refused := &APIError{Method: method, StatusCode: response.StatusCode, Status: response.Status, Body: string(raw)}
		var body struct {
			Code int `json:"code"`
		}
		_ = json.Unmarshal(raw, &body)
		refused.Code = body.Code
		return "", refused
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &created)
	return created.ID, nil
}
