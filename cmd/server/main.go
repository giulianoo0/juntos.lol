package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/httpapi"
	"github.com/giulianoo0/ss/internal/media"
	"github.com/giulianoo0/ss/internal/room"
	syncapi "github.com/giulianoo0/ss/internal/sync"
	"github.com/giulianoo0/ss/internal/upload"
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

	ctx := context.Background()
	go room.StartSweeper(ctx, store, cfg.DataDir, time.Minute)
	hub := syncapi.NewHub(store, cfg)
	defer hub.Close()
	queue := media.NewQueue(cfg.FFmpegJobs, store, cfg.DataDir, func(roomID string) {
		hub.NotifyStatus(roomID, "ready")
	})
	queue.Start(ctx)
	if err := queue.Recover(ctx); err != nil {
		log.Printf("recover interrupted media jobs: %v", err)
	}
	progressive := media.NewProgressive(cfg.FFmpegJobs, store, cfg.DataDir, func(roomID string) {
		hub.NotifyStatus(roomID, "ready")
	})
	progressive.Start(ctx)

	r := httpapi.NewServer(cfg, store, hub, httpapi.WithSourceHooks(httpapi.SourceHooks{
		// Swapping the source retires the previous media, so any preview still
		// being built for it has to stop before its files are removed.
		CancelMedia:  progressive.Cancel,
		NotifyStatus: hub.NotifyStatus,
	}))

	tusHandler, err := upload.NewTusHandler(cfg, store,
		func(roomID string) {
			progressive.Cancel(roomID)
			queue.Submit(roomID)
		},
		progressive.Submit,
		func(roomID string) {
			progressive.Cancel(roomID)
			updateCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := store.SetError(updateCtx, roomID, "upload failed"); err != nil {
				log.Printf("mark terminated upload failed: %v", err)
			}
			hub.NotifyStatus(roomID, "error")
		},
	)
	if err != nil {
		log.Fatal(err)
	}
	r.Any("/api/upload", gin.WrapH(http.StripPrefix("/api/upload", tusHandler)))
	r.Any("/api/upload/*path", gin.WrapH(http.StripPrefix("/api/upload", tusHandler)))

	if err := r.Run(fmt.Sprintf(":%d", cfg.Port)); err != nil {
		log.Fatal(err)
	}
}
