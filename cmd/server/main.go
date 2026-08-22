package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/httpapi"
	"github.com/giulianoo0/ss/internal/media"
	"github.com/giulianoo0/ss/internal/metrics"
	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
	syncapi "github.com/giulianoo0/ss/internal/sync"
	"github.com/giulianoo0/ss/internal/torrent"
	"github.com/giulianoo0/ss/internal/upload"
	"github.com/giulianoo0/ss/internal/urlingest"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	// Before anything else can fail: a metrics port already in use is a
	// deployment mistake, and finding it out at boot is the point of binding
	// here rather than inside a goroutine.
	if cfg.MetricsPort != 0 {
		if err := metrics.Serve(cfg.MetricsPort); err != nil {
			log.Fatal(err)
		}
	}

	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatal(err)
	}
	rdb := redis.NewClient(opts)
	store := room.NewStore(rdb, time.Duration(cfg.RoomTTLHours)*time.Hour)

	bucket, err := objectstore.NewR2(objectstore.R2Config{
		AccountID: cfg.R2AccountID,
		Bucket:    cfg.R2Bucket,
		AccessKey: cfg.R2AccessKeyID,
		SecretKey: cfg.R2SecretAccessKey,
		Endpoint:  cfg.R2Endpoint,
		Insecure:  cfg.R2Insecure,
	})
	if err != nil {
		log.Fatal(err)
	}
	publisher := media.NewPublisher(store, bucket, cfg.MediaPublicURL)

	ctx := context.Background()
	go room.StartSweeper(ctx, store, cfg.DataDir, bucket, time.Minute,
		time.Duration(cfg.UploadIdleMinutes)*time.Minute)
	go room.StartStatsSampler(ctx, store, roomCensusInterval)
	hub := syncapi.NewHub(store, cfg, bucket)
	defer hub.Close()
	queue := media.NewQueue(cfg.FFmpegJobs, store, cfg.DataDir, publisher, func(roomID string) {
		hub.NotifyStatus(roomID, "ready")
	}, hub.NotifyRoomUpdated)
	// The queue reports back into the hub, so it cannot be built before one;
	// the hub is told about it here instead, before either serves anything.
	// It is only started further down, once killRoom exists: recovery can
	// resubmit a refused source, and a purge hook that is not installed yet
	// would silently keep that room's bytes.
	hub.SetMediaWork(queue)
	streamStartBytes := cfg.StreamStartMB << 20
	// killRoom is how a room dies before its time: told why, cut off from
	// whatever is still feeding it, and stripped of every byte it accumulated.
	// Late-bound because the ingestors it must stop are built further down.
	var killRoom func(roomID string)
	progressive := media.NewProgressive(cfg.FFmpegJobs, store, cfg.DataDir, publisher, streamStartBytes,
		func(roomID string) { hub.NotifyStatus(roomID, "ready") },
		hub.NotifyRoomUpdated,
		func(roomID string) {
			if killRoom != nil {
				killRoom(roomID)
			}
		},
	)
	// Started below, after killRoom is assigned: the workers read it, and a
	// worker racing the assignment would be a data race, not merely a miss.

	// The ingest talks to this same server over loopback, so a torrent takes
	// the identical path a browser upload does and inherits its whole
	// lifecycle. Without a bridge configured it stays disabled and the browser
	// keeps doing the upload itself.
	ingestor := torrent.NewIngestor(
		torrent.NewBridge(cfg.TorrentBridgeURL),
		fmt.Sprintf("http://127.0.0.1:%d/api/upload/", cfg.Port),
		cfg.FFmpegJobs,
		media.IsSubtitleFileName,
		torrent.Hooks{
			OnSubtitles: publishSideSubtitles(store, hub, publisher, cfg.DataDir),
			OnFailed: func(roomID string, err error) {
				failCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				if setErr := store.SetError(failCtx, roomID, "torrent download failed"); setErr != nil {
					log.Printf("mark failed torrent ingest: %v", setErr)
				}
				hub.NotifyStatus(roomID, "error")
			},
		},
	)
	ingestor.Start(ctx)

	// The same trade, for a url a plugin produced. It takes the loopback tus
	// path too, and it is the only place in the server that fetches an address
	// third-party code chose — hence the guard in urlingest.
	urlIngestor := urlingest.NewIngestor(
		fmt.Sprintf("http://127.0.0.1:%d/api/upload/", cfg.Port),
		cfg.FFmpegJobs,
		cfg.MaxUploadMB<<20,
		urlingest.Hooks{
			OnFailed: func(roomID string, err error) {
				failCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				if setErr := store.SetError(failCtx, roomID, "url download failed"); setErr != nil {
					log.Printf("mark failed url ingest: %v", setErr)
				}
				hub.NotifyStatus(roomID, "error")
			},
		},
	)
	urlIngestor.Start(ctx)

	killRoom = func(roomID string) {
		// The pumps stop first, so nothing rebuilds what the purge removes.
		ingestor.Cancel(roomID)
		urlIngestor.Cancel(roomID)
		progressive.Cancel(roomID)
		killCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := store.SetError(killCtx, roomID, media.PublicUnsupportedVideo); err != nil {
			log.Printf("mark refused room %s: %v", roomID, err)
		}
		hub.NotifyStatus(roomID, "error")
		// The dying preview's publisher makes one detached last pass on its
		// way out; purging under it would let that pass resurrect what was
		// just removed. The bytes go only once the job is truly gone.
		go func() {
			select {
			case <-progressive.Done(roomID):
			case <-time.After(2 * time.Minute):
			}
			purgeCtx, cancelPurge := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancelPurge()
			if err := room.PurgeData(purgeCtx, store, cfg.DataDir, bucket, roomID); err != nil {
				log.Printf("purge refused room %s: %v", roomID, err)
			}
		}()
	}
	// The queue reaches the same verdict for sources that could only be
	// probed after the upload landed; it marks the room itself and hands the
	// teardown here.
	queue.SetPurge(func(roomID string) { killRoom(roomID) })
	queue.Start(ctx)
	if err := queue.Recover(ctx); err != nil {
		log.Printf("recover interrupted media jobs: %v", err)
	}
	progressive.Start(ctx)

	r := httpapi.NewServer(cfg, store, hub,
		httpapi.WithSubtitlePublisher(publisher),
		httpapi.WithClientMedia(bucket, httpapi.ClientMediaHooks{
			NotifyStatus:      hub.NotifyStatus,
			NotifyRoomUpdated: hub.NotifyRoomUpdated,
		}),
		httpapi.WithURLIngestor(urlIngestor),
		httpapi.WithSourceHooks(httpapi.SourceHooks{
			// Swapping the source retires the previous media, so any preview
			// still being built for it has to stop before its files are
			// removed, and so must any torrent still feeding it.
			CancelMedia: func(roomID string) {
				progressive.Cancel(roomID)
				ingestor.Cancel(roomID)
				urlIngestor.Cancel(roomID)
			},
			NotifyStatus: hub.NotifyStatus,
		}),
		httpapi.WithTorrentIngestor(ingestor),
	)

	tusHandler, err := upload.NewTusHandler(cfg, store, upload.Callbacks{
		OnComplete: func(roomID string) {
			// The preview is not cut off when the upload lands: it drains to
			// the file's end and keeps publishing, so nobody hits a frozen
			// playlist while the slower final encode replaces it from behind.
			// The final pass starts only once the preview has fully wound
			// down — the two must never write the same directory at once.
			progressive.Complete(roomID)
			go media.SubmitAfterPreview(ctx, progressive, queue, roomID)
		},
		OnStreamStart: progressive.Submit,
		OnTerminate: func(roomID string) {
			progressive.Cancel(roomID)
			ingestor.Cancel(roomID)
			updateCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := store.SetError(updateCtx, roomID, "upload failed"); err != nil {
				log.Printf("mark terminated upload failed: %v", err)
			}
			hub.NotifyStatus(roomID, "error")
		},
		OnProgress: publishIngestProgress(store, hub),
	})
	if err != nil {
		log.Fatal(err)
	}
	r.Any("/api/upload", gin.WrapH(http.StripPrefix("/api/upload", tusHandler)))
	r.Any("/api/upload/*path", gin.WrapH(http.StripPrefix("/api/upload", tusHandler)))

	if err := r.Run(fmt.Sprintf(":%d", cfg.Port)); err != nil {
		log.Fatal(err)
	}
}

// roomCensusInterval is how often the number of live rooms is counted for the
// metrics endpoint. Rooms are minutes-to-hours things and the count costs a
// Redis round trip per room, so anything faster would be paying for precision
// no graph could show.
const roomCensusInterval = 15 * time.Second

// progressPublishInterval throttles how often an upload's byte count is
// persisted and broadcast. Progress ticks arrive twice a second per upload,
// and a viewer's waiting screen does not read any better for it.
const progressPublishInterval = time.Second

// publishIngestProgress records how much of a source has landed and tells the
// room about it.
//
// This exists for every upload, not only torrents: until now the byte count
// lived in the tab doing the sending, so anyone else in the room saw a
// preparing screen with no numbers on it at all, and with the server doing the
// sending there would be no tab to ask.
func publishIngestProgress(store *room.Store, hub *syncapi.Hub) func(string, int64, int64) {
	var mu sync.Mutex
	last := make(map[string]time.Time)
	return func(roomID string, received, total int64) {
		now := time.Now()
		mu.Lock()
		if seen, ok := last[roomID]; ok && now.Sub(seen) < progressPublishInterval && received < total {
			mu.Unlock()
			return
		}
		last[roomID] = now
		if received >= total {
			delete(last, roomID)
		}
		mu.Unlock()

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := store.SetIngestProgress(ctx, roomID, received, total); err != nil {
			return
		}
		hub.NotifyRoomUpdated(roomID)
	}
}

// publishSideSubtitles converts the subtitle files that shipped alongside a
// torrent video and publishes them straight away.
//
// They are marked incomplete on purpose: the authoritative ffmpeg pass over
// the finished video still runs and still contributes the tracks muxed into
// the container itself, and the two sets are merged then.
func publishSideSubtitles(store *room.Store, hub *syncapi.Hub, publisher *media.Publisher,
	dataDir string) func(string, []torrent.SideFile) {
	return func(roomID string, files []torrent.SideFile) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()

		payload := make(map[string][]byte, len(files))
		for _, file := range files {
			payload[file.Name] = file.Data
		}
		subsDir := filepath.Join(dataDir, "rooms", roomID, "subs")
		converted, err := media.ConvertSideSubtitles(ctx, subsDir, payload)
		if err != nil || len(converted) == 0 {
			if err != nil {
				log.Printf("convert torrent subtitles for %s: %v", roomID, err)
			}
			return
		}

		tracks, err := media.StoreExternalSubtitles(subsDir, converted)
		if err != nil {
			log.Printf("store torrent subtitles for %s: %v", roomID, err)
			return
		}
		if len(tracks) == 0 {
			return
		}
		if err := publisher.PublishSubtitles(ctx, roomID, subsDir); err != nil {
			log.Printf("upload torrent subtitles for %s: %v", roomID, err)
			return
		}
		if err := store.SetClientSubtitles(ctx, roomID, tracks, false); err != nil {
			log.Printf("publish torrent subtitles for %s: %v", roomID, err)
			return
		}
		hub.NotifyRoomUpdated(roomID)
	}
}
