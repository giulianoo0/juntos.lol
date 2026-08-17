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
	queue := media.NewQueue(cfg.FFmpegJobs, store, cfg.DataDir, nil)
	queue.Start(ctx)

	r := httpapi.NewServer(cfg, store)

	tusHandler, err := upload.NewTusHandler(cfg, store, queue.Submit)
	if err != nil {
		log.Fatal(err)
	}
	r.Any("/api/upload", gin.WrapH(http.StripPrefix("/api/upload", tusHandler)))
	r.Any("/api/upload/*path", gin.WrapH(http.StripPrefix("/api/upload", tusHandler)))

	if err := r.Run(fmt.Sprintf(":%d", cfg.Port)); err != nil {
		log.Fatal(err)
	}
}
