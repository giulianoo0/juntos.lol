// The ss server does no media work: it creates rooms, keeps their members in step
// over WebSocket, signs the bucket writes the host's browser makes while remuxing
// its own source, and accepts the playlists that come out of that.
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
	"github.com/giulianoo0/ss/internal/objectstore"
	"github.com/giulianoo0/ss/internal/room"
	syncapi "github.com/giulianoo0/ss/internal/sync"
	"github.com/giulianoo0/ss/internal/worker"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
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
	hub := syncapi.NewHub(store, cfg, bucket)
	defer hub.Close()

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
		RelayBase: cfg.WorkerRelayBase,
		JobTTL:    time.Duration(cfg.RoomTTLHours) * time.Hour,
	}
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
			Peers: stats.Peers, DownSpeed: stats.DownSpeed, HaveBytes: stats.HaveBytes,
			SelectedBytes: stats.SelectedBytes, DiskBytes: stats.DiskBytes,
		}); err != nil {
			return
		}
		hub.NotifyRoomUpdated(roomID)
	}
	remuxOrch := worker.NewRemuxOrchestrator(torrents, store, cfg)
	remuxOrch.Notify = hub.NotifyRoomUpdated
	hub.OnRoomReclaimed(func(roomID string) {
		remuxOrch.CancelRoom(roomID)
		torrents.CancelRoom(roomID)
	})
	hub.OnPosition(remuxOrch.Follow)
	workerHub.OnHeartbeat(func(workerID string, hb worker.Heartbeat) {
		torrents.Charge(workerID, hb)
		remuxOrch.ObserveHeartbeat(workerID, hb)
	})
	go torrents.StartSweeper(ctx, time.Minute, time.Duration(cfg.UploadIdleMinutes)*time.Minute)
	sessions := httpapi.NewSessions(rdb, time.Duration(cfg.SessionTTLDays)*24*time.Hour, cfg.SessionsPerIPPerHour, cfg.BehindCloudflare)

	r := httpapi.NewServer(cfg, store, hub,
		httpapi.WithSubtitlePublisher(publisher),
		httpapi.WithClientMedia(bucket, httpapi.ClientMediaHooks{
			NotifyStatus:       hub.NotifyStatus,
			NotifyRoomUpdated:  hub.NotifyRoomUpdated,
			NotifyRoomMedia:    hub.NotifyRoomMedia,
			NotifyRoomProgress: hub.NotifyRoomProgress,
		}),
		httpapi.WithSourceHooks(httpapi.SourceHooks{NotifyStatus: hub.NotifyStatus, CancelMedia: func(roomID string) {
			remuxOrch.CancelRoom(roomID)
			torrents.CancelRoom(roomID)
		}}),
		httpapi.WithTorrents(httpapi.TorrentAccess{Sessions: sessions, Quota: quota, Service: torrents,
			Remux: remuxOrch, Authorizer: hub.AuthorizeMember}, workerHub.HandleLink),
		httpapi.WithPluginFetch(sessions, quota),
	)

	if err := r.Run(fmt.Sprintf(":%d", cfg.Port)); err != nil {
		log.Fatal(err)
	}
}
