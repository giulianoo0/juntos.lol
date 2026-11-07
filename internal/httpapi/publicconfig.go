package httpapi

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
)

// publicConfig is what the page needs to know and the server already does:
// identifiers, never secrets. Empty values mean the feature is off.
func publicConfig(cfg config.Config) gin.HandlerFunc {
	body := gin.H{
		"turnstileSiteKey": "",
		"discordAppId":     cfg.DiscordAppID,
		"extensionBase":    cfg.ExtensionBase,
		"extensionScheme":  cfg.ExtensionScheme,
		"extensionRaw":     cfg.GitHubRawBase,
	}
	if cfg.TurnstileSecret != "" {
		body["turnstileSiteKey"] = cfg.TurnstileSiteKey
	}
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, body)
	}
}
