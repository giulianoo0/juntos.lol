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

func (a *API) call(ctx context.Context, method, path string, asBot bool, message any) (string, error) {
	body, err := json.Marshal(message)
	if err != nil {
		return "", fmt.Errorf("marshal discord message: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, method, a.Base+path, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
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
		return "", fmt.Errorf("discord %s: %s: %s", method, response.Status, raw)
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &created)
	return created.ID, nil
}
