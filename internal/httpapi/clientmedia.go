package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/sync/errgroup"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/media"
	"github.com/giulianoo0/ss/internal/metrics"
	"github.com/giulianoo0/ss/internal/room"
)

// The client media pipeline's server half. A capable browser remuxes the
// source itself and PUTs segments straight into the bucket; these routes are
// everything the server still owns: the claim that makes the browser the
// room's one producer, the presigns that scope what it may write, and the
// acceptance step that turns its playlists into published media without ever
// trusting them — a playlist only names objects the bucket has confirmed.
//
// Trust model, deliberately identical to tus: possession of the room id plus
// being first is what authorizes an upload today, and the claim secret is
// that same authorization with a token the later calls can present.

const (
	maxClientMediaBodyBytes = 4 << 20
	// maxPresignObjects bounds one presign call; the client batches.
	maxPresignObjects = 64
	// maxConfirmObjects bounds one acceptance call's HEAD bill.
	maxConfirmObjects = 128
	// presignExpiry is how long a signed PUT stays valid. Segments upload in
	// seconds; the slack is for retries, not for hoarding URLs.
	presignExpiry = 15 * time.Minute
	// confirmConcurrency is how many HEADs run at once during acceptance.
	confirmConcurrency = 8
	// budgetSlack is how far past the room's upload limit the presign budget
	// may run: remuxed output can exceed the source a little, never by much.
	budgetSlackNumerator   = 5
	budgetSlackDenominator = 4
	maxClientAudioTracks   = 32
	maxClientChapters      = 512
)

// ClientMediaBucket is the part of the bucket this path needs: signing
// writes it will never relay, and confirming they landed without reading
// the bytes back.
type ClientMediaBucket interface {
	Stat(ctx context.Context, key string) (int64, error)
	PresignPut(ctx context.Context, key, contentType, cacheControl string, size int64, expiry time.Duration) (string, http.Header, error)
}

// ClientMediaHooks tells connected clients what the acceptance step changed.
// Both are nil-safe.
type ClientMediaHooks struct {
	NotifyStatus      func(roomID, status string)
	NotifyRoomUpdated func(roomID string)
}

// RegisterClientMediaRoutes mounts the claim, presign and publish endpoints.
func RegisterClientMediaRoutes(rg *gin.RouterGroup, store *room.Store, cfg config.Config,
	bucket ClientMediaBucket, hooks ClientMediaHooks) {
	if bucket == nil {
		return
	}
	rg.POST("/rooms/:id/client-media/claim", claimClientMedia(store, cfg))
	rg.POST("/rooms/:id/client-media/presign", presignClientMedia(store, cfg, bucket))
	rg.POST("/rooms/:id/client-media/publish", publishClientMedia(store, cfg, bucket, hooks))
	rg.DELETE("/rooms/:id/client-media", releaseClientMedia(store))
}

type clientClaimResponse struct {
	Claim           string `json:"claim"`
	MediaGeneration int    `json:"mediaGeneration"`
	MaxBytes        int64  `json:"maxBytes"`
}

func claimClientMedia(store *room.Store, cfg config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}
		storedRoom, ok := loadLiveRoom(c, store, roomID)
		if !ok {
			return
		}
		secret := make([]byte, 16)
		if _, err := rand.Read(secret); err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		claim := "client:" + hex.EncodeToString(secret)
		err := store.ReserveUpload(c.Request.Context(), roomID, claim, time.Now())
		switch {
		case errors.Is(err, room.ErrUploadReserved):
			c.JSON(http.StatusConflict, gin.H{"error": "upload_reserved"})
			return
		case err != nil:
			c.JSON(http.StatusConflict, gin.H{"error": "room_not_uploading"})
			return
		}
		c.JSON(http.StatusOK, clientClaimResponse{
			Claim:           claim,
			MediaGeneration: storedRoom.MediaGeneration,
			MaxBytes:        maxClientBytes(cfg),
		})
	}
}

type presignRequest struct {
	Claim   string `json:"claim" binding:"required"`
	Objects []struct {
		Name string `json:"name" binding:"required"`
		Size int64  `json:"size" binding:"required"`
	} `json:"objects" binding:"required"`
}

type presignedObject struct {
	Name    string            `json:"name"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

func presignClientMedia(store *room.Store, cfg config.Config, bucket ClientMediaBucket) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxClientMediaBodyBytes)
		var req presignRequest
		if err := c.ShouldBindJSON(&req); err != nil || len(req.Objects) == 0 || len(req.Objects) > maxPresignObjects {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		storedRoom, ok := authorizeClaim(c, store, roomID, req.Claim)
		if !ok {
			return
		}

		var declared int64
		types := make([]string, len(req.Objects))
		for i, object := range req.Objects {
			contentType, valid := media.ClientObjectContentType(object.Name)
			if !valid || object.Size <= 0 || object.Size > media.MaxClientObjectBytes {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid object", "name": object.Name})
				return
			}
			types[i] = contentType
			declared += object.Size
		}
		// The budget is charged for what the client declares, and the
		// declaration is not a promise but a constraint: the presign signs
		// the exact Content-Length below, so the bucket refuses any PUT whose
		// body is not that size. Declared bytes are therefore real bytes.
		total, err := store.AddClientMediaBytes(c.Request.Context(), roomID, declared)
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		if total > maxClientBytes(cfg) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "upload_budget_exceeded"})
			return
		}

		signed := make([]presignedObject, len(req.Objects))
		for i, object := range req.Objects {
			key := media.HLSObjectKey(roomID, storedRoom.MediaGeneration, object.Name)
			url, headers, err := bucket.PresignPut(c.Request.Context(), key, types[i],
				media.ClientObjectCacheControl, object.Size, presignExpiry)
			if err != nil {
				slog.ErrorContext(c.Request.Context(), "presign client media failed",
					"room_id", roomID, "name", object.Name, "error", err)
				c.Status(http.StatusInternalServerError)
				return
			}
			flat := make(map[string]string, len(headers))
			for name := range headers {
				flat[name] = headers.Get(name)
			}
			signed[i] = presignedObject{Name: object.Name, URL: url, Headers: flat}
		}
		metrics.ClientMediaPresigned.Add(float64(len(signed)))
		metrics.ClientMediaPresignedBytes.Add(float64(declared))
		c.JSON(http.StatusOK, gin.H{"objects": signed})
	}
}

type clientChapter struct {
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"`
	Title   string `json:"title"`
}

type clientAudioTrack struct {
	Index    int    `json:"index"`
	Language string `json:"language"`
	Title    string `json:"title"`
	Codec    string `json:"codec"`
}

type publishRequest struct {
	Claim           string             `json:"claim" binding:"required"`
	MediaGeneration *int               `json:"mediaGeneration"`
	Confirm         []string           `json:"confirm"`
	Playlists       map[string]string  `json:"playlists"`
	AudioTracks     []clientAudioTrack `json:"audioTracks"`
	Chapters        []clientChapter    `json:"chapters"`
	Progress        *struct {
		ReceivedBytes int64 `json:"receivedBytes"`
		SourceBytes   int64 `json:"sourceBytes"`
	} `json:"progress"`
	// Timeline carries the source's full duration and the current region's
	// start. The offset is applied only on the publish whose master actually
	// rendered, and its change is what bumps the media version.
	Timeline *struct {
		DurationMs int64              `json:"durationMs"`
		OffsetMs   int64              `json:"offsetMs"`
		Regions    []room.MediaRegion `json:"regions"`
	} `json:"timeline"`
	Complete bool `json:"complete"`
}

// maxClientRegions bounds the region list one run may report.
const maxClientRegions = 64

func publishClientMedia(store *room.Store, cfg config.Config, bucket ClientMediaBucket,
	hooks ClientMediaHooks) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxClientMediaBodyBytes)
		var req publishRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		storedRoom, ok := authorizeClaim(c, store, roomID, req.Claim)
		if !ok {
			return
		}
		// The remux outlives source swaps; media for a generation the room
		// has already replaced must not land on the new one.
		if req.MediaGeneration != nil && *req.MediaGeneration != storedRoom.MediaGeneration {
			c.JSON(http.StatusConflict, gin.H{"error": "stale_generation"})
			return
		}
		ctx := c.Request.Context()

		// Confirmation is a HEAD per newly-claimed object: "it landed" is a
		// client assertion until the bucket vouches for it, and only vouched
		// objects enter the published set the playlist render trusts.
		if len(req.Confirm) > maxConfirmObjects {
			c.JSON(http.StatusBadRequest, gin.H{"error": "too many confirmations"})
			return
		}
		confirmed := make([]string, 0, len(req.Confirm))
		var group errgroup.Group
		group.SetLimit(confirmConcurrency)
		results := make([]bool, len(req.Confirm))
		for i, name := range req.Confirm {
			if _, valid := media.ClientObjectContentType(name); !valid {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid object", "name": name})
				return
			}
			group.Go(func() error {
				size, err := bucket.Stat(ctx, media.HLSObjectKey(roomID, storedRoom.MediaGeneration, name))
				results[i] = err == nil && size > 0
				return nil
			})
		}
		_ = group.Wait()
		for i, name := range req.Confirm {
			if results[i] {
				confirmed = append(confirmed, name)
			}
		}
		if len(confirmed) > 0 {
			if err := store.MarkPublished(ctx, roomID, confirmed...); err != nil {
				c.Status(http.StatusInternalServerError)
				return
			}
		}

		// Playlists are rendered exactly like the publisher renders its own:
		// bucket URLs prepended and the list cut at the first object the
		// published set has not confirmed. A viewer never gets a 404.
		rendered, playable, ok := renderClientPlaylists(c, store, cfg, roomID, storedRoom.MediaGeneration, req.Playlists)
		if !ok {
			return
		}
		if len(rendered) > 0 {
			if err := store.SetPlaylists(ctx, roomID, rendered); err != nil {
				c.Status(http.StatusInternalServerError)
				return
			}
		}

		if !storeClientMetadata(c, store, roomID, req) {
			return
		}
		if req.Timeline != nil {
			if req.Timeline.DurationMs < 0 || req.Timeline.OffsetMs < 0 || !validRegions(req.Timeline.Regions) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
				return
			}
			// The region map only names regions whose master has rendered:
			// a player sent to rN_master.m3u8 must find it.
			if regions := renderedRegions(ctx, store, roomID, req.Timeline.Regions, rendered); regions != nil && !sameRegions(regions, storedRoom.MediaRegions) {
				if err := store.SetMediaRegions(ctx, roomID, regions); err != nil {
					c.Status(http.StatusInternalServerError)
					return
				}
				if hooks.NotifyRoomUpdated != nil {
					hooks.NotifyRoomUpdated(roomID)
				}
			}
			if req.Timeline.DurationMs > 0 && req.Timeline.DurationMs != storedRoom.DurationMs {
				if err := store.SetMediaDuration(ctx, roomID, req.Timeline.DurationMs); err != nil {
					slog.WarnContext(ctx, "store media duration failed", "room_id", roomID, "error", err)
				}
			}
			// The offset only moves once this publish carried a rendered
			// master: reloading players into a master that still points at the
			// old region would put their clock on the wrong timeline.
			_, masterRendered := rendered["master.m3u8"]
			if masterRendered && req.Timeline.OffsetMs != storedRoom.MediaOffsetMs {
				if err := store.SetMediaOffset(ctx, roomID, req.Timeline.OffsetMs); err != nil {
					c.Status(http.StatusInternalServerError)
					return
				}
				if hooks.NotifyRoomUpdated != nil {
					hooks.NotifyRoomUpdated(roomID)
				}
			}
		}
		if req.Progress != nil {
			// The browser counts what it uploaded, which is the remux's output
			// and never equals the source's size. The complete pass is what
			// says the whole source has been read, so it lands the figure.
			received := req.Progress.ReceivedBytes
			if req.Complete {
				received = req.Progress.SourceBytes
			}
			if err := store.SetIngestProgress(ctx, roomID, received, req.Progress.SourceBytes); err == nil &&
				hooks.NotifyRoomUpdated != nil {
				hooks.NotifyRoomUpdated(roomID)
			}
		}

		becameReady := false
		// Playable alone is one variant with a segment; the player's first
		// request is for the master, and a ready room whose master is still
		// waiting on its slowest rendition serves that request a 404 the
		// player eventually gives up on. Ready means the master resolves.
		masterReady := false
		if _, ok := rendered["master.m3u8"]; ok {
			masterReady = true
		} else if has, err := store.HasPlaylist(ctx, roomID, "master.m3u8"); err == nil && has {
			masterReady = true
		}
		if playable && masterReady && storedRoom.Status != "ready" {
			if err := store.SetStatus(ctx, roomID, "ready"); err == nil {
				becameReady = true
				if hooks.NotifyStatus != nil {
					hooks.NotifyStatus(roomID, "ready")
				}
			}
		}
		roomReady := becameReady || storedRoom.Status == "ready"
		// Every publish is a heartbeat: a run still uploading has not gone
		// stale, whatever the sweeper's clock says.
		if !req.Complete {
			_ = store.TouchClientClaim(ctx, roomID)
		}
		if req.Complete {
			// The claim is released either way, so the fallback tus upload can
			// take the room. But a "complete" run that never made the room
			// playable failed, and the client must be told so it falls back
			// rather than leaving a room stuck in "uploading" with no media.
			if err := store.ReleaseUpload(ctx, roomID, req.Claim); err != nil {
				slog.WarnContext(ctx, "release client media claim failed", "room_id", roomID, "error", err)
			}
			if !roomReady {
				c.JSON(http.StatusConflict, gin.H{"error": "no_playable_media"})
				return
			}
			if hooks.NotifyRoomUpdated != nil {
				hooks.NotifyRoomUpdated(roomID)
			}
			slog.InfoContext(ctx, "client media complete", "room_id", roomID)
		}
		c.JSON(http.StatusOK, gin.H{"confirmed": confirmed, "ready": roomReady})
	}
}

// renderClientPlaylists validates names, renders media playlists against the
// published set, and validates the master against the names it may know.
func renderClientPlaylists(c *gin.Context, store *room.Store, cfg config.Config,
	roomID string, generation int, playlists map[string]string) (map[string]string, bool, bool) {
	if len(playlists) == 0 {
		return nil, false, true
	}
	ctx := c.Request.Context()
	published, err := store.Published(ctx, roomID)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return nil, false, false
	}
	rendered := make(map[string]string, len(playlists))
	playable := false
	for name, body := range playlists {
		if !media.ValidClientPlaylistName(name) || len(body) > media.MaxClientPlaylistBytes {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid playlist", "name": name})
			return nil, false, false
		}
		if strings.HasSuffix(name, "master.m3u8") {
			continue // validated after every media playlist is known
		}
		if media.IsMasterPlaylist([]byte(body)) || !media.SanitizeClientMediaPlaylist([]byte(body)) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid playlist", "name": name})
			return nil, false, false
		}
		out, ok := media.RenderClientPlaylist(cfg.MediaPublicURL, roomID, generation, []byte(body), published)
		if !ok {
			// Nothing in this playlist is confirmed yet; publish it later.
			continue
		}
		rendered[name] = out
		if strings.Contains(out, "#EXTINF") {
			playable = true
		}
	}
	available := func(name string) bool {
		if _, ok := rendered[name]; ok {
			return true
		}
		has, err := store.HasPlaylist(ctx, roomID, name)
		return err == nil && has
	}
	// master.m3u8 is the region still growing; rN_master.m3u8 is each region's
	// own, which is what a player on that region loads.
	for name, master := range playlists {
		if !strings.HasSuffix(name, "master.m3u8") {
			continue
		}
		switch media.JudgeClientMaster([]byte(master), available) {
		case media.ClientMasterInvalid:
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid playlist", "name": name})
			return nil, false, false
		case media.ClientMasterReady:
			rendered[name] = master
		case media.ClientMasterEarly:
			// Sound, but a variant it names has no confirmed segments yet.
			// Every run starts here; publish the master once the variant
			// lands, and never fail the round for it.
		}
	}
	return rendered, playable, true
}

func validRegions(regions []room.MediaRegion) bool {
	if len(regions) > maxClientRegions {
		return false
	}
	seen := map[int]struct{}{}
	for _, r := range regions {
		if r.N < 0 || r.N > 999_999 || r.StartMs < 0 || r.ProducedMs < 0 {
			return false
		}
		if _, dup := seen[r.N]; dup {
			return false
		}
		seen[r.N] = struct{}{}
	}
	return true
}

// renderedRegions keeps the regions whose master the server holds, so the
// map never points a player at a playlist that is not there. Nil means the
// request carried no regions at all.
func renderedRegions(ctx context.Context, store *room.Store, roomID string, regions []room.MediaRegion, rendered map[string]string) []room.MediaRegion {
	if regions == nil {
		return nil
	}
	out := make([]room.MediaRegion, 0, len(regions))
	for _, r := range regions {
		name := "r" + strconv.Itoa(r.N) + "_master.m3u8"
		if _, ok := rendered[name]; ok {
			out = append(out, r)
			continue
		}
		if has, err := store.HasPlaylist(ctx, roomID, name); err == nil && has {
			out = append(out, r)
		}
	}
	return out
}

func sameRegions(a, b []room.MediaRegion) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// storeClientMetadata persists the track and chapter annotations the client
// read from the source. They are annotations, never security: validated for
// shape and bounds, and worth a warning rather than a failed publish.
func storeClientMetadata(c *gin.Context, store *room.Store, roomID string, req publishRequest) bool {
	ctx := c.Request.Context()
	if len(req.AudioTracks) > maxClientAudioTracks || len(req.Chapters) > maxClientChapters {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return false
	}
	if len(req.AudioTracks) > 0 {
		audio := make([]room.TrackInfo, 0, len(req.AudioTracks))
		for i, track := range req.AudioTracks {
			if !validSubtitleTitle(track.Title) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid track title"})
				return false
			}
			audio = append(audio, room.TrackInfo{
				Index:    i,
				Language: sanitizeSubtitleLanguage(track.Language),
				Title:    track.Title,
				Codec:    "aac",
			})
		}
		if err := store.SetAudioTracks(ctx, roomID, audio, 0); err != nil {
			slog.WarnContext(ctx, "store client audio tracks failed", "room_id", roomID, "error", err)
		}
	}
	if len(req.Chapters) > 0 {
		chapters := make([]room.Chapter, 0, len(req.Chapters))
		for _, chapter := range req.Chapters {
			if chapter.EndMs <= chapter.StartMs || !validSubtitleTitle(chapter.Title) || len(chapter.Title) > 200 {
				continue
			}
			chapters = append(chapters, room.Chapter{StartMs: chapter.StartMs, EndMs: chapter.EndMs, Title: chapter.Title})
		}
		if err := store.SetChapters(ctx, roomID, chapters); err != nil {
			slog.WarnContext(ctx, "store client chapters failed", "room_id", roomID, "error", err)
		}
	}
	return true
}

func releaseClientMedia(store *room.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}
		claim := c.Query("claim")
		if !strings.HasPrefix(claim, "client:") {
			c.Status(http.StatusForbidden)
			return
		}
		if _, ok := authorizeClaimValue(c, store, roomID, claim); !ok {
			return
		}
		if err := store.ReleaseUpload(c.Request.Context(), roomID, claim); err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.Status(http.StatusNoContent)
	}
}

// authorizeClaim proves the caller holds the room's producer reservation.
func authorizeClaim(c *gin.Context, store *room.Store, roomID, claim string) (*room.Room, bool) {
	if !strings.HasPrefix(claim, "client:") {
		c.JSON(http.StatusForbidden, gin.H{"error": "claim_mismatch"})
		return nil, false
	}
	return authorizeClaimValue(c, store, roomID, claim)
}

func authorizeClaimValue(c *gin.Context, store *room.Store, roomID, claim string) (*room.Room, bool) {
	storedRoom, ok := loadLiveRoom(c, store, roomID)
	if !ok {
		return nil, false
	}
	held, err := store.UploadID(c.Request.Context(), roomID)
	if err != nil || held == "" || held != claim {
		c.JSON(http.StatusForbidden, gin.H{"error": "claim_mismatch"})
		return nil, false
	}
	return storedRoom, true
}

// loadLiveRoom answers 404 for rooms that are gone or expired.
func loadLiveRoom(c *gin.Context, store *room.Store, roomID string) (*room.Room, bool) {
	storedRoom, err := store.Get(c.Request.Context(), roomID)
	if errors.Is(err, room.ErrNotFound) || err == nil && !storedRoom.ExpiresAt.After(time.Now()) {
		c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
		return nil, false
	}
	if err != nil {
		slog.ErrorContext(c.Request.Context(), "load room for client media", "room_id", roomID, "error", err)
		c.Status(http.StatusInternalServerError)
		return nil, false
	}
	return storedRoom, true
}

func maxClientBytes(cfg config.Config) int64 {
	return cfg.MaxUploadMB << 20 * budgetSlackNumerator / budgetSlackDenominator
}
