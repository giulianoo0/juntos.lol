package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	stdsync "sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/account"
	"github.com/giulianoo0/ss/internal/room"
	"github.com/giulianoo0/ss/internal/usage"
	"github.com/giulianoo0/ss/internal/worker"
)

// dataDays is how far back /data looks.
const dataDays = 90

// dataFresh is how long one answer serves everyone who asks.
const dataFresh = 30 * time.Second

type dataDay struct {
	Day     string        `json:"day"`
	Metrics usage.Metrics `json:"metrics"`
}

type dataNow struct {
	Rooms        int            `json:"rooms"`
	Members      int            `json:"members"`
	RoomsByState map[string]int `json:"roomsByState"`
}

type dataFleet struct {
	Online          int   `json:"online"`
	Total           int   `json:"total"`
	Torrents        int   `json:"torrents"`
	Leases          int   `json:"leases"`
	DiskUsed        int64 `json:"diskUsed"`
	DiskQuota       int64 `json:"diskQuota"`
	TransferUsedBps int64 `json:"transferUsedBps"`
	TransferCapBps  int64 `json:"transferCapBps"`
}

type dataReport struct {
	GeneratedAt time.Time       `json:"generatedAt"`
	Now         dataNow         `json:"now"`
	Fleet       dataFleet       `json:"fleet"`
	Accounts    *account.Census `json:"accounts,omitempty"`
	Days        []dataDay       `json:"days"`
}

// dataSources is everything /data reads; any of them may be missing.
type dataSources struct {
	usage    *usage.Counter
	accounts *account.Store
	rooms    *room.Store
	live     func() (rooms, members int)
	fleet    func() []worker.FleetMember
}

// serveData answers GET /api/data: how the site is used, in totals only,
// for the public page at /data.
func serveData(sources dataSources) gin.HandlerFunc {
	var mu stdsync.Mutex
	var cached *dataReport
	return func(c *gin.Context) {
		mu.Lock()
		defer mu.Unlock()
		if cached == nil || time.Since(cached.GeneratedAt) > dataFresh {
			ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
			report, err := sources.report(ctx)
			cancel()
			if err != nil {
				slog.ErrorContext(c.Request.Context(), "data report failed", "error", err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
				return
			}
			cached = report
		}
		c.JSON(http.StatusOK, cached)
	}
}

func (s dataSources) report(ctx context.Context) (*dataReport, error) {
	now := time.Now()
	report := &dataReport{GeneratedAt: now, Days: []dataDay{}}
	if s.live != nil {
		report.Now.Rooms, report.Now.Members = s.live()
	}
	if s.rooms != nil {
		census, err := s.rooms.Census(ctx)
		if err != nil {
			return nil, err
		}
		report.Now.RoomsByState = census.ByState
	}
	if s.fleet != nil {
		for _, member := range s.fleet() {
			report.Fleet.Total++
			if member.Availability == "available" || member.Availability == "busy" {
				report.Fleet.Online++
			}
			report.Fleet.Torrents += member.Torrents
			report.Fleet.Leases += member.Leases
			report.Fleet.DiskUsed += member.DiskUsed
			report.Fleet.DiskQuota += member.DiskQuota
			report.Fleet.TransferUsedBps += member.TransferUsedBps
			report.Fleet.TransferCapBps += member.TransferCapBps
		}
	}
	since := now.AddDate(0, 0, -(dataDays - 1))
	if s.accounts != nil {
		census, err := s.accounts.Census(ctx, since)
		if err != nil {
			return nil, err
		}
		report.Accounts = &census
	}
	if s.usage != nil {
		first := usage.DayOf(since)
		history, err := s.usage.History(ctx, first)
		if err != nil {
			return nil, err
		}
		for day := since; ; day = day.AddDate(0, 0, 1) {
			name := usage.DayOf(day)
			metrics := history[name]
			if metrics == nil {
				metrics = usage.Metrics{}
			}
			report.Days = append(report.Days, dataDay{Day: name, Metrics: metrics})
			if name == s.usage.Today() {
				break
			}
		}
	}
	return report, nil
}
