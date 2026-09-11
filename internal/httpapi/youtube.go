package httpapi

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/worker"
)

var youtubeIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// YoutubeVideoID reads the video id out of the link shapes people paste:
// watch, youtu.be, shorts, live, embed, music. Anything else is refused, so
// the worker only ever sees a canonical watch URL.
func YoutubeVideoID(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 2048 {
		return "", false
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return "", false
	}
	host := strings.ToLower(strings.TrimPrefix(parsed.Hostname(), "www."))
	host = strings.TrimPrefix(host, "m.")
	host = strings.TrimPrefix(host, "music.")
	var id string
	switch host {
	case "youtu.be":
		id = strings.Trim(parsed.Path, "/")
	case "youtube.com", "youtube-nocookie.com":
		path := strings.Trim(parsed.Path, "/")
		switch {
		case path == "watch":
			id = parsed.Query().Get("v")
		case strings.HasPrefix(path, "shorts/"), strings.HasPrefix(path, "live/"),
			strings.HasPrefix(path, "embed/"), strings.HasPrefix(path, "v/"):
			id = path[strings.Index(path, "/")+1:]
		default:
			return "", false
		}
	default:
		return "", false
	}
	if i := strings.IndexAny(id, "/?&#"); i >= 0 {
		id = id[:i]
	}
	if !youtubeIDRe.MatchString(id) {
		return "", false
	}
	return id, true
}

// CanonicalYoutubeURL is the one shape the worker resolves.
func CanonicalYoutubeURL(id string) string {
	return "https://www.youtube.com/watch?v=" + id
}

type youtubeStartRequest struct {
	URL string `json:"url"`
}

// RegisterYoutubeRoutes mounts /api/youtube: a link becomes a job the fleet
// resolves, then the same remux route as a torrent hands the room to the
// job's worker. Capacity is public; the rest carries a session and the
// dispatch budget torrents share.
func RegisterYoutubeRoutes(rg *gin.RouterGroup, cfg config.Config, access TorrentAccess) {
	if access.Service == nil {
		rg.GET("/youtube/capacity", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"capacity": "disabled"})
		})
		return
	}
	rg.GET("/youtube/capacity", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"capacity": access.Service.YoutubeCapacity()})
	})
	group := rg.Group("/youtube")
	if access.Sessions != nil {
		group.Use(access.Sessions.Middleware())
	}
	start := []gin.HandlerFunc{}
	if access.Quota != nil {
		start = append(start, access.Quota.Dispatch())
	}
	start = append(start, startYoutube(access.Service))
	group.POST("", start...)
	group.GET("/:jobId", getYoutube(access.Service))
	group.POST("/:jobId/remux", startRemux(access))
	group.DELETE("/:jobId", releaseTorrent(access.Service))
}

func startYoutube(service *worker.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req youtubeStartRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_url"})
			return
		}
		id, ok := YoutubeVideoID(req.URL)
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_url"})
			return
		}
		job, err := service.StartYoutube(c.Request.Context(), SessionID(c), CanonicalYoutubeURL(id))
		if err != nil {
			status, code := youtubeErrorStatus(err)
			c.JSON(status, gin.H{"error": code})
			return
		}
		c.JSON(http.StatusAccepted, gin.H{"jobId": job.ID, "state": job.State, "videoId": id})
	}
}

func getYoutube(service *worker.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		job, err := service.Get(c.Request.Context(), SessionID(c), c.Param("jobId"))
		if err != nil || job.Kind != worker.JobKindYoutube {
			if err == nil {
				err = worker.ErrJobNotFound
			}
			status, code := youtubeErrorStatus(err)
			c.JSON(status, gin.H{"error": code})
			return
		}
		body := gin.H{"jobId": job.ID, "state": job.State, "url": job.URL}
		if job.Error != "" {
			body["error"] = job.Error
		}
		if len(job.Summary) > 0 {
			body["summary"] = job.Summary
		}
		c.JSON(http.StatusOK, body)
	}
}

func youtubeErrorStatus(err error) (int, string) {
	if err == worker.ErrNoYoutube {
		return http.StatusServiceUnavailable, "no_youtube"
	}
	return torrentErrorStatus(err)
}
