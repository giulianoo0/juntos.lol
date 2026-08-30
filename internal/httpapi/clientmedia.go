package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"slices"
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
	// NotifyRoomProgress carries the same meaning as NotifyRoomUpdated for the
	// one signal worth coalescing: the preparo's byte counters moving. Falls
	// back to NotifyRoomUpdated when unset.
	NotifyRoomProgress func(roomID string)
	// NotifyRoomMedia carries what a publish changed. Falls back to
	// NotifyRoomUpdated when unset.
	NotifyRoomMedia func(roomID string, media room.MediaSnapshot)
	// NotifyPlaylists says this room's playlists just changed: a request
	// holding for the next segment can have it now.
	NotifyPlaylists func(roomID string)
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
	rg.POST("/rooms/:id/client-media/metadata", metadataClientMedia(store, hooks))
	rg.DELETE("/rooms/:id/client-media", releaseClientMedia(store))
}

type clientClaimResponse struct {
	Claim           string `json:"claim"`
	MediaGeneration int    `json:"mediaGeneration"`
	MaxBytes        int64  `json:"maxBytes"`
	// MetadataToken authorizes the late-metadata endpoint. It outlives the
	// claim (chapters can surface after complete) but dies with the source:
	// a swap, an expiry or a reclaim revokes it.
	MetadataToken string `json:"metadataToken"`
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
		metaSecret := make([]byte, 16)
		if _, err := rand.Read(metaSecret); err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		metadataToken := "meta:" + hex.EncodeToString(metaSecret)
		if err := store.SetMetadataToken(c.Request.Context(), roomID, metadataToken); err != nil {
			slog.WarnContext(c.Request.Context(), "store metadata token failed", "room_id", roomID, "error", err)
			metadataToken = ""
		}
		c.JSON(http.StatusOK, clientClaimResponse{
			Claim:           claim,
			MediaGeneration: storedRoom.MediaGeneration,
			MaxBytes:        maxClientBytes(cfg),
			MetadataToken:   metadataToken,
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
	Claim           string `json:"claim" binding:"required"`
	MediaGeneration *int   `json:"mediaGeneration"`
	// RunID identifies this execution of the producer; Seq orders its
	// publishes. Older clients send neither and skip run fencing — their
	// commit is still atomic under claim and generation.
	RunID   string   `json:"runId"`
	Seq     *int64   `json:"seq"`
	Confirm []string `json:"confirm"`
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
		ctx := c.Request.Context()
		// A complete whose response was lost is retried against a claim the
		// server already released. The receipt is what keeps that retry from
		// reading as a source swap.
		if req.Complete {
			if receipt, err := store.CompleteReceiptFor(ctx, roomID, req.Claim); err == nil && receipt != nil {
				c.JSON(http.StatusOK, gin.H{"confirmed": []string{}, "ready": receipt.Ready})
				return
			}
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

		// Playlists are rendered exactly like the publisher renders its own:
		// bucket URLs prepended and the list cut at the first object the
		// published set has not confirmed. A viewer never gets a 404. The
		// names this very round confirmed count as published for the render;
		// the commit below is what makes both facts true together.
		rendered, playable, ok := renderClientPlaylists(c, store, cfg, roomID, storedRoom.MediaGeneration, req.Playlists, confirmed)
		if !ok {
			return
		}

		if req.Timeline != nil &&
			(req.Timeline.DurationMs < 0 || req.Timeline.OffsetMs < 0 || !validRegions(req.Timeline.Regions)) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		commit := room.PublishCommit{
			Claim:      req.Claim,
			Generation: storedRoom.MediaGeneration,
			RunID:      req.RunID,
			Digest:     publishDigest(req),
			Heartbeat:  !req.Complete,
			Confirmed:  confirmed,
			Playlists:  rendered,
		}
		if req.Seq != nil {
			commit.Seq = *req.Seq
		}
		regionsChanged := false
		_, masterRendered := rendered["master.m3u8"]
		if req.Timeline != nil {
			// The region map only names regions whose master has rendered:
			// a player sent to rN_master.m3u8 must find it.
			if regions := renderedRegions(ctx, store, roomID, req.Timeline.Regions, rendered, storedRoom.MediaRegions); regions != nil && !sameRegions(regions, storedRoom.MediaRegions) {
				commit.Regions = regions
				regionsChanged = true
			}
			commit.DurationMs = req.Timeline.DurationMs
			// The offset only moves once this publish carried a rendered
			// master: reloading players into a master that still points at the
			// old region would put their clock on the wrong timeline.
			if masterRendered {
				commit.ApplyOffset = true
				commit.OffsetMs = req.Timeline.OffsetMs
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
			commit.ReceivedBytes = &received
			commit.SourceBytes = &req.Progress.SourceBytes
		}

		// Everything this publish changes lands in one atomic step, refused
		// whole if the room expired, the claim moved, the generation was
		// swapped, or a newer publish of this run already committed. The
		// HEADs above authorized nothing by themselves.
		outcome, err := store.CommitPublish(ctx, roomID, commit)
		switch {
		case errors.Is(err, room.ErrNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		case errors.Is(err, room.ErrCommitClaim):
			c.JSON(http.StatusForbidden, gin.H{"error": "claim_mismatch"})
			return
		case errors.Is(err, room.ErrCommitGeneration):
			c.JSON(http.StatusConflict, gin.H{"error": "stale_generation"})
			return
		case errors.Is(err, room.ErrCommitRun):
			c.JSON(http.StatusConflict, gin.H{"error": "stale_run"})
			return
		case errors.Is(err, room.ErrCommitSeq):
			c.JSON(http.StatusConflict, gin.H{"error": "stale_seq"})
			return
		case err != nil:
			slog.ErrorContext(ctx, "publish commit failed", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}

		if !storeClientMetadata(c, store, roomID, req) {
			return
		}

		// Notifications only follow an accepted commit: a refused publish
		// must not produce readiness or region changes for viewers.
		if !outcome.Replayed {
			if len(rendered) > 0 && hooks.NotifyPlaylists != nil {
				hooks.NotifyPlaylists(roomID)
			}
			// One update per publish, however many things it moved, and it
			// carries what moved: two bare updates used to cost every viewer
			// two room fetches and the player two rebuilds.
			if regionsChanged || outcome.VersionBumped {
				notifyMedia(ctx, store, roomID, hooks)
			}
			if req.Progress != nil {
				// Progress alone goes down the throttled path when the caller
				// offers one: every wake costs each viewer a room refetch.
				notifyProgress := hooks.NotifyRoomProgress
				if notifyProgress == nil {
					notifyProgress = hooks.NotifyRoomUpdated
				}
				if notifyProgress != nil {
					notifyProgress(roomID)
				}
			}
		}

		becameReady := false
		// Playable alone is one variant with a segment; the player's first
		// request is for the master, and a ready room whose master is still
		// waiting on its slowest rendition serves that request a 404 the
		// player eventually gives up on. Ready means the master resolves.
		masterReady := masterRendered
		if !masterReady {
			if has, err := store.HasPlaylist(ctx, roomID, "master.m3u8"); err == nil && has {
				masterReady = true
			}
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
		if req.Complete {
			// The receipt goes down before the claim is released: a retry that
			// lost this response must find it, not a released claim.
			if err := store.StoreCompleteReceipt(ctx, roomID, req.Claim,
				room.CompleteReceipt{Ready: roomReady}, time.Hour); err != nil {
				slog.WarnContext(ctx, "store complete receipt failed", "room_id", roomID, "error", err)
			}
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

// publishDigest fingerprints a publish's logical payload, so a retry of the
// same sequence is told apart from a different publish reusing it. It hashes
// the request as sent — not the HEAD results, which can legitimately differ
// between the original and its retry.
func publishDigest(req publishRequest) string {
	h := sha256.New()
	for _, name := range req.Confirm {
		h.Write([]byte(name))
		h.Write([]byte{0})
	}
	names := make([]string, 0, len(req.Playlists))
	for name := range req.Playlists {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		h.Write([]byte(name))
		h.Write([]byte{0})
		h.Write([]byte(req.Playlists[name]))
		h.Write([]byte{0})
	}
	if req.Complete {
		h.Write([]byte("complete"))
	}
	return hex.EncodeToString(h.Sum(nil)[:16])
}

// renderClientPlaylists validates names, renders media playlists against the
// published set, and validates the master against the names it may know.
func renderClientPlaylists(c *gin.Context, store *room.Store, cfg config.Config,
	roomID string, generation int, playlists map[string]string, confirmed []string) (map[string]string, bool, bool) {
	if len(playlists) == 0 {
		return nil, false, true
	}
	ctx := c.Request.Context()
	published, err := store.Published(ctx, roomID)
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return nil, false, false
	}
	// What this very round confirmed renders as published; the commit that
	// follows makes the playlist and the set land together.
	for _, name := range confirmed {
		published[name] = struct{}{}
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
// request carried no regions at all. A failed lookup must not shrink the
// map: a region already published stays in it, because dropping it would
// yank every player off a playlist that is in fact still there.
func renderedRegions(ctx context.Context, store *room.Store, roomID string, regions []room.MediaRegion, rendered map[string]string, current []room.MediaRegion) []room.MediaRegion {
	if regions == nil {
		return nil
	}
	known := make(map[int]struct{}, len(current))
	for _, r := range current {
		known[r.N] = struct{}{}
	}
	out := make([]room.MediaRegion, 0, len(regions))
	for _, r := range regions {
		name := "r" + strconv.Itoa(r.N) + "_master.m3u8"
		if _, ok := rendered[name]; ok {
			out = append(out, r)
			continue
		}
		has, err := store.HasPlaylist(ctx, roomID, name)
		if err != nil {
			if _, ok := known[r.N]; ok {
				out = append(out, r)
			}
			continue
		}
		if has {
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

type metadataRequest struct {
	Token           string             `json:"token" binding:"required"`
	MediaGeneration *int               `json:"mediaGeneration"`
	Chapters        []clientChapter    `json:"chapters"`
	AudioTracks     []clientAudioTrack `json:"audioTracks"`
}

// metadataClientMedia accepts late metadata — chapters, track annotations —
// under the producer's metadata token. Chapters live in cold parts of the
// file and may only surface after the media completed and the claim was
// released; this endpoint is why that never holds the media back. It cannot
// touch readiness, playlists or regions, and its token dies with the source.
func metadataClientMedia(store *room.Store, hooks ClientMediaHooks) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxClientMediaBodyBytes)
		var req metadataRequest
		if err := c.ShouldBindJSON(&req); err != nil || !strings.HasPrefix(req.Token, "meta:") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		storedRoom, ok := loadLiveRoom(c, store, roomID)
		if !ok {
			return
		}
		if req.MediaGeneration != nil && *req.MediaGeneration != storedRoom.MediaGeneration {
			c.JSON(http.StatusConflict, gin.H{"error": "stale_generation"})
			return
		}
		matches, err := store.MetadataTokenMatches(c.Request.Context(), roomID, req.Token)
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		if !matches {
			c.JSON(http.StatusForbidden, gin.H{"error": "token_mismatch"})
			return
		}
		if !storeClientMetadata(c, store, roomID, publishRequest{
			Chapters:    req.Chapters,
			AudioTracks: req.AudioTracks,
		}) {
			return
		}
		if (len(req.Chapters) > 0 || len(req.AudioTracks) > 0) && hooks.NotifyRoomUpdated != nil {
			hooks.NotifyRoomUpdated(roomID)
		}
		c.Status(http.StatusNoContent)
	}
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

// notifyMedia announces a publish that moved the room's media, with the
// room as it now stands when the hook can carry it.
func notifyMedia(ctx context.Context, store *room.Store, roomID string, hooks ClientMediaHooks) {
	if hooks.NotifyRoomMedia != nil {
		if fresh, err := store.Get(ctx, roomID); err == nil {
			hooks.NotifyRoomMedia(roomID, fresh.Snapshot())
			return
		}
	}
	if hooks.NotifyRoomUpdated != nil {
		hooks.NotifyRoomUpdated(roomID)
	}
}
