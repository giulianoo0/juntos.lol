package main

import (
	"fmt"
	"log"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	r := gin.Default()
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(200, gin.H{"ok": true})
	})

	if err := r.Run(fmt.Sprintf(":%d", cfg.Port)); err != nil {
		log.Fatal(err)
	}
}
