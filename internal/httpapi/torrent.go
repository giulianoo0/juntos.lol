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
	"github.com/giulianoo0/ss/internal/remux"
	"github.com/giulianoo0/ss/internal/worker"
)

var infohashRe = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)

// TorrentAccess is everything the torrent routes hang off. A nil Remux keeps the
// remux route answering remux_unavailable; Authorizer proves a memberId+capability
// pair names a connected member.
type TorrentAccess struct {
	Sessions   *Sessions
	Quota      *Quota
	Service    *worker.Service
	Remux      *worker.RemuxOrchestrator
	Authorizer func(roomID, memberID, capability string) bool
}

// RegisterTorrentRoutes mounts /api/torrents. Capacity and fleet are public; the
// rest carries a session and the dispatch budget.
func RegisterTorrentRoutes(rg *gin.RouterGroup, cfg config.Config, access TorrentAccess) {
	if access.Service == nil {
		rg.GET("/torrents/capacity", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"capacity": "disabled"})
		})
		rg.GET("/fleet", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"capacity": "disabled", "workers": []worker.FleetMember{}})
		})
		return
	}
	rg.GET("/torrents/capacity", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"capacity": access.Service.Capacity()})
	})
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
	group.POST("/:jobId/remux", startRemux(access))
	group.DELETE("/:jobId", releaseTorrent(access.Service))
}

// startRemux hands the room's production to the job's worker; 202 is neither ready
// nor running, and progress arrives through the room.
func startRemux(access TorrentAccess) gin.HandlerFunc {
	return func(c *gin.Context) {
		if access.Remux == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "remux_unavailable"})
			return
		}
		var req remux.StartRequest
		if err := c.ShouldBindJSON(&req); err != nil || !validMediaRoomID(req.RoomID) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		var authorize func(memberID, capability string) bool
		if access.Authorizer != nil {
			roomID := req.RoomID
			authorize = func(memberID, capability string) bool {
				return access.Authorizer(roomID, memberID, capability)
			}
		}
		response, err := access.Remux.Start(c.Request.Context(), SessionID(c), c.Param("jobId"), req, authorize)
		if err != nil {
			status, code := remuxErrorStatus(err)
			c.JSON(status, gin.H{"error": code})
			return
		}
		c.JSON(http.StatusAccepted, response)
	}
}

func remuxErrorStatus(err error) (int, string) {
	switch {
	case errors.Is(err, worker.ErrRemuxUnavailable):
		return http.StatusServiceUnavailable, "remux_unavailable"
	case errors.Is(err, worker.ErrRemuxConflict):
		return http.StatusConflict, "upload_reserved"
	case errors.Is(err, worker.ErrRemuxDenied):
		return http.StatusForbidden, "not_authorized"
	case errors.Is(err, worker.ErrRemuxRoomState):
		return http.StatusConflict, "room_state"
	default:
		return torrentErrorStatus(err)
	}
}

type startRequest struct {
	InfoHash  string   `json:"infoHash"`
	Trackers  []string `json:"trackers"`
	DN        string   `json:"dn"`
	Preferred []string `json:"preferred"`
}

// cleanTrackers keeps only udp/http/https trackers and never an IP literal in a
// non-public range, since the worker announces to whatever the signed job names.
// Hostnames pass as written: DNS resolves on the worker, out of reach from here.
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

// listWorkers hands the page what it needs to measure the fleet before a dispatch:
// every healthy worker, its read base, and a probe ticket.
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

// audience is the origin the ticket is scoped to: the configured public origin,
// else the browser's own Origin header (dev, single box).
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
