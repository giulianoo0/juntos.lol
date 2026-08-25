package main

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/httpapi"
	"github.com/giulianoo0/ss/internal/media"
	"github.com/giulianoo0/ss/internal/metrics"
	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
	syncapi "github.com/giulianoo0/ss/internal/sync"
	"github.com/giulianoo0/ss/internal/worker"
)

// The server does no media work. It creates rooms, keeps their members in
// step over WebSocket, signs the bucket writes the host's browser makes while
// remuxing its own source, and accepts the playlists that come out of that.
// Every video byte and every second of CPU spent on it belongs to the host's
// machine.
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

	// The worker fleet. Without an enrollment secret the torrent path reports
	// itself disabled and everything else runs as before.
	signer, err := worker.LoadOrCreateSigner(cfg.WorkerSigningKeyFile)
	if err != nil {
		log.Fatal(err)
	}
	blocklist, err := worker.LoadBlocklist(cfg.TorrentBlocklistFile)
	if err != nil {
		log.Fatal(err)
	}
	registry := worker.NewRegistry(rdb)
	workerHub := worker.NewHub(registry, signer, cfg.WorkerEnrollmentSecret)
	quota := httpapi.NewQuota(rdb, cfg.TorrentDispatchPerHour, cfg.TorrentConcurrentJobs, cfg.TorrentBytesPerDayGB<<30)
	torrents := &worker.Service{
		Registry:  registry,
		Hub:       workerHub,
		Signer:    signer,
		Blocklist: blocklist,
		Quota:     quota,
		TicketTTL: time.Duration(cfg.WorkerTicketMinutes) * time.Minute,
		JobTTL:    time.Duration(cfg.RoomTTLHours) * time.Hour,
	}
	// Every heartbeat would otherwise make every member refetch the room;
	// only numbers that moved are worth telling.
	var swarmMu sync.Mutex
	lastSwarm := map[string]worker.SwarmStats{}
	torrents.OnSwarm = func(roomID string, stats worker.SwarmStats) {
		swarmMu.Lock()
		same := lastSwarm[roomID] == stats
		lastSwarm[roomID] = stats
		swarmMu.Unlock()
		if same {
			return
		}
		swarmCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if err := store.SetSwarm(swarmCtx, roomID, room.SwarmStats{
			Peers: stats.Peers, DownSpeed: stats.DownSpeed, HaveBytes: stats.HaveBytes, SelectedBytes: stats.SelectedBytes,
		}); err != nil {
			return
		}
		hub.NotifyRoomUpdated(roomID)
	}
	workerHub.OnHeartbeat(torrents.Charge)
	go torrents.StartSweeper(ctx, time.Minute, time.Duration(cfg.UploadIdleMinutes)*time.Minute)
	sessions := httpapi.NewSessions(rdb, time.Duration(cfg.SessionTTLDays)*24*time.Hour, cfg.SessionsPerIPPerHour, cfg.BehindCloudflare)

	r := httpapi.NewServer(cfg, store, hub,
		httpapi.WithSubtitlePublisher(publisher),
		httpapi.WithClientMedia(bucket, httpapi.ClientMediaHooks{
			NotifyStatus:      hub.NotifyStatus,
			NotifyRoomUpdated: hub.NotifyRoomUpdated,
		}),
		httpapi.WithSourceHooks(httpapi.SourceHooks{NotifyStatus: hub.NotifyStatus, CancelMedia: torrents.CancelRoom}),
		httpapi.WithTorrents(httpapi.TorrentAccess{Sessions: sessions, Quota: quota, Service: torrents}, workerHub.HandleLink),
	)

	if err := r.Run(fmt.Sprintf(":%d", cfg.Port)); err != nil {
		log.Fatal(err)
	}
}

// roomCensusInterval is how often the number of live rooms is counted for the
// metrics endpoint. Rooms are minutes-to-hours things and the count costs a
// Redis round trip per room, so anything faster would be paying for precision
// no graph could show.
const roomCensusInterval = 15 * time.Second
