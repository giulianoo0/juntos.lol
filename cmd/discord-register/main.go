// Command discord-register installs the Juntos app's slash commands on
// Discord, globally: run it once after creating the app, and again whenever
// the command set changes.
//
//	DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… go run ./cmd/discord-register
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/giulianoo0/ss/internal/discord"
)

func main() {
	appID := strings.TrimSpace(os.Getenv("DISCORD_APP_ID"))
	botToken := strings.TrimSpace(os.Getenv("DISCORD_BOT_TOKEN"))
	if appID == "" || botToken == "" {
		log.Fatal("DISCORD_APP_ID and DISCORD_BOT_TOKEN are required")
	}
	base := strings.TrimSuffix(strings.TrimSpace(os.Getenv("DISCORD_API_BASE")), "/")
	if base == "" {
		base = "https://discord.com/api/v10"
	}
	api := &discord.API{Base: base, AppID: appID, BotToken: botToken, Client: &http.Client{Timeout: 30 * time.Second}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := api.RegisterCommands(ctx); err != nil {
		log.Fatal(err)
	}
	log.Print("registered /juntos new")
}
