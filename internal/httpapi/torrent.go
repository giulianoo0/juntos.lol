package httpapi

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/worker"
)

// The torrent routes: the debrid state machine, verbatim. Register an
// infohash, poll for the listing (metadata resolves in the swarm, seconds
// to a minute), select the file, and receive where to read it from. The
// browser never learns a worker's address before the server has decided
// it may read there.

var infohashRe = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)

// TorrentAccess is everything the torrent routes hang off.
type TorrentAccess struct {
	Sessions *Sessions
	Quota    *Quota
	Service  *worker.Service
}

// RegisterTorrentRoutes mounts /api/torrents. Capacity is public; the rest
// carries a session and the dispatch budget.
func RegisterTorrentRoutes(rg *gin.RouterGroup, cfg config.Config, access TorrentAccess) {
	if access.Service == nil {
		rg.GET("/torrents/capacity", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"capacity": "disabled"})
		})
		// A build with no fleet still answers, so the status page can say so
		// instead of failing to load.
		rg.GET("/fleet", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"capacity": "disabled", "workers": []worker.FleetMember{}})
		})
		return
	}
	rg.GET("/torrents/capacity", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"capacity": access.Service.Capacity()})
	})
	// Public, like capacity: it says how busy the fleet is, never where it
	// lives, and everyone about to start a room is entitled to know.
	rg.GET("/fleet", func(c *gin.Context) {
		fleet := access.Service.Fleet()
		if fleet == nil {
			fleet = []worker.FleetMember{}
		}
		c.JSON(http.StatusOK, gin.H{"capacity": access.Service.Capacity(), "workers": fleet})
	})
	group := rg.Group("/torrents")
	if access.Sessions != nil {
		group.Use(access.Sessions.Middleware())
	}
	group.GET("/workers", listWorkers(access.Service, cfg, access.Quota))
	start := []gin.HandlerFunc{}
	if access.Quota != nil {
		start = append(start, access.Quota.Dispatch())
	}
	start = append(start, startTorrent(access.Service))
	group.POST("", start...)
	group.GET("/:jobId", getTorrent(access.Service))
	group.POST("/:jobId/select", selectTorrent(access.Service, cfg))
	group.POST("/:jobId/token", tokenTorrent(access.Service))
	group.DELETE("/:jobId", releaseTorrent(access.Service))
}

type startRequest struct {
	InfoHash string   `json:"infoHash"`
	Trackers []string `json:"trackers"`
	DN       string   `json:"dn"`
	// The page's own worker ranking, best first, from its probes.
	Preferred []string `json:"preferred"`
}

// cleanTrackers keeps only trackers a worker may announce to: udp, http or
// https — anything else librqbit drops anyway — and never an IP literal in
// a non-public range. The worker trusts the signed job and would announce
// to cloud metadata, internal services or a victim's host on the word of
// whoever pasted the magnet. Hostnames pass as written: DNS is resolved on
// the worker, where a rebind check cannot follow from here.
func cleanTrackers(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	for _, raw := range in {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil {
			continue
		}
		switch u.Scheme {
		case "udp", "http", "https":
		default:
			continue
		}
		host := u.Hostname()
		if host == "" {
			continue
		}
		if ip, err := netip.ParseAddr(host); err == nil {
			ip = ip.Unmap()
			if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsMulticast() {
				return nil, fmt.Errorf("tracker %q does not point at a public address", raw)
			}
		}
		out = append(out, u.String())
	}
	return out, nil
}

// listWorkers hands the page what it needs to measure the fleet before a
// dispatch: every healthy worker, its read base, and a probe ticket.
func listWorkers(service *worker.Service, cfg config.Config, quota *Quota) gin.HandlerFunc {
	return func(c *gin.Context) {
		if quota != nil {
			ok, err := quota.CheckProbes(c.Request.Context(), SessionID(c))
			if err != nil {
				slog.Error("probe quota check", "error", err)
				c.Status(http.StatusInternalServerError)
				return
			}
			if !ok {
				c.JSON(http.StatusTooManyRequests, gin.H{"error": "quota_exceeded", "reason": "probe_limit"})
				return
			}
		}
		infoHash := strings.ToLower(c.Query("infoHash"))
		if infoHash != "" && !infohashRe.MatchString(infoHash) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_infohash"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"workers": service.ProbeList(infoHash, audience(c, cfg))})
	}
}

func startTorrent(service *worker.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req startRequest
		if err := c.ShouldBindJSON(&req); err != nil || !infohashRe.MatchString(req.InfoHash) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_infohash"})
			return
		}
		if len(req.Trackers) > 20 {
			req.Trackers = req.Trackers[:20]
		}
		trackers, err := cleanTrackers(req.Trackers)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_tracker"})
			return
		}
		if len(req.Preferred) > 8 {
			req.Preferred = req.Preferred[:8]
		}
		job, err := service.Start(c.Request.Context(), SessionID(c), strings.ToLower(req.InfoHash), req.DN, trackers, req.Preferred)
		if err != nil {
			status, code := torrentErrorStatus(err)
			c.JSON(status, gin.H{"error": code})
			return
		}
		c.JSON(http.StatusAccepted, gin.H{"jobId": job.ID, "state": job.State})
	}
}

func getTorrent(service *worker.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		job, err := service.Get(c.Request.Context(), SessionID(c), c.Param("jobId"))
		if err != nil {
			status, code := torrentErrorStatus(err)
			c.JSON(status, gin.H{"error": code})
			return
		}
		body := gin.H{"jobId": job.ID, "state": job.State, "infoHash": job.Infohash}
		if job.Error != "" {
			body["error"] = job.Error
		}
		// The stats poll runs every couple of seconds for as long as the
		// download does and only ever reads the swarm; the listing is the
		// same few kilobytes of paths every time it asks.
		if c.Query("only") != "swarm" {
			if job.Name != "" {
				body["name"] = job.Name
			}
			if job.Files != nil {
				body["files"] = job.Files
			}
		}
		if swarm := service.Swarm(job); swarm != nil {
			body["swarm"] = swarm
		}
		c.JSON(http.StatusOK, body)
	}
}

type selectRequest struct {
	FileIndex int    `json:"fileIndex"`
	RoomID    string `json:"roomId"`
}

// audience is the origin the ticket is scoped to: the configured public
// origin, else the browser's own Origin header (dev, single box).
func audience(c *gin.Context, cfg config.Config) string {
	if cfg.PublicOrigin != "" {
		return cfg.PublicOrigin
	}
	if origin := c.GetHeader("Origin"); origin != "" {
		return origin
	}
	scheme := "http"
	if c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + c.Request.Host
}

func selectTorrent(service *worker.Service, cfg config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req selectRequest
		if err := c.ShouldBindJSON(&req); err != nil || req.FileIndex < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		grant, err := service.Select(c.Request.Context(), SessionID(c), c.Param("jobId"), req.FileIndex, req.RoomID, audience(c, cfg))
		if err != nil {
			status, code := torrentErrorStatus(err)
			c.JSON(status, gin.H{"error": code})
			return
		}
		c.JSON(http.StatusOK, grant)
	}
}

type tokenRequest struct {
	RoomID string `json:"roomId"`
}

func tokenTorrent(service *worker.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req tokenRequest
		if c.Request.ContentLength > 0 {
			_ = c.ShouldBindJSON(&req)
		}
		grant, err := service.Token(c.Request.Context(), SessionID(c), c.Param("jobId"), req.RoomID)
		if err != nil {
			status, code := torrentErrorStatus(err)
			c.JSON(status, gin.H{"error": code})
			return
		}
		c.JSON(http.StatusOK, grant)
	}
}

func releaseTorrent(service *worker.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := service.Release(c.Request.Context(), SessionID(c), c.Param("jobId")); err != nil {
			status, code := torrentErrorStatus(err)
			c.JSON(status, gin.H{"error": code})
			return
		}
		c.Status(http.StatusNoContent)
	}
}

func torrentErrorStatus(err error) (int, string) {
	var werr *worker.WorkerError
	switch {
	case errors.Is(err, worker.ErrBlocked):
		return http.StatusForbidden, "blocked"
	case errors.Is(err, worker.ErrDisabled), errors.Is(err, worker.ErrNoWorkers):
		return http.StatusServiceUnavailable, "no_workers"
	case errors.Is(err, worker.ErrWorkersBusy):
		return http.StatusServiceUnavailable, "workers_busy"
	case errors.Is(err, worker.ErrQuotaJobs):
		return http.StatusTooManyRequests, "concurrent_jobs"
	case errors.Is(err, worker.ErrJobNotFound), errors.Is(err, worker.ErrNotYours):
		return http.StatusNotFound, "job_not_found"
	case errors.Is(err, worker.ErrNotListed):
		return http.StatusConflict, "not_listed"
	case errors.Is(err, worker.ErrWorkerGone):
		return http.StatusServiceUnavailable, "worker_gone"
	case errors.As(err, &werr):
		return http.StatusBadGateway, werr.Code
	default:
		slog.Error("torrent route", "error", err)
		return http.StatusInternalServerError, "internal"
	}
}
