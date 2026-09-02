package worker

import (
	"sort"
	"time"
)

// FleetMember is one worker as the status page sees it. Deliberately no
// address: the page ranks the fleet, it does not dial it.
type FleetMember struct {
	ID              string  `json:"id"`
	Version         string  `json:"version,omitempty"`
	Availability    string  `json:"availability"`
	Load            float64 `json:"load"`
	Leases          int     `json:"leases"`
	MaxLeases       int     `json:"maxLeases,omitempty"`
	Torrents        int     `json:"torrents"`
	MaxTorrents     int     `json:"maxTorrents,omitempty"`
	DiskUsed        int64   `json:"diskUsed"`
	DiskReal        int64   `json:"diskReal"`
	DiskQuota       int64   `json:"diskQuota,omitempty"`
	TransferUsedBps int64   `json:"transferUsedBps"`
	TransferCapBps  int64   `json:"transferCapBps,omitempty"`
	UptimeSecs      int64   `json:"uptimeSecs,omitempty"`
	LastSeenSecs    int64   `json:"lastSeenSecs"`
}

// availabilityRank orders the categories the way a person would want to be
// served: takes work now, might soon, is leaving, is gone.
func availabilityRank(availability string) int {
	switch availability {
	case "available":
		return 0
	case "busy":
		return 1
	case "draining":
		return 2
	default:
		return 3
	}
}

// Fleet reports every worker this instance knows, best for a viewer first.
// The order is the same one Place uses, so the top of the list is genuinely
// where the next room would land.
func (r *Registry) Fleet(now time.Time) []FleetMember {
	snapshot := r.Snapshot()
	out := make([]FleetMember, 0, len(snapshot))
	for _, w := range snapshot {
		hb := w.Heartbeat
		member := FleetMember{
			ID:           w.ID,
			Version:      hb.Version,
			Leases:       hb.Leases,
			MaxLeases:    hb.MaxLeases,
			Torrents:     len(hb.Torrents),
			MaxTorrents:  hb.MaxTorrents,
			DiskUsed:     hb.Disk.Used,
			DiskReal:     hb.Disk.Real,
			DiskQuota:    hb.Disk.Quota,
			UptimeSecs:   hb.UptimeSecs,
			LastSeenSecs: int64(now.Sub(w.LastSeen).Seconds()),
		}
		if hb.Transfer != nil {
			member.TransferUsedBps = hb.Transfer.UsedBps
			member.TransferCapBps = hb.Transfer.CapBps
		}
		switch {
		case !w.Healthy(now) && hb.Draining:
			member.Availability = "draining"
		case !w.Healthy(now):
			member.Availability = "offline"
		case hasRoom(w, 0):
			member.Availability = "available"
			member.Load = loadOf(w)
		default:
			member.Availability = "busy"
			member.Load = loadOf(w)
		}
		out = append(out, member)
	}
	sort.SliceStable(out, func(i, j int) bool {
		left, right := availabilityRank(out[i].Availability), availabilityRank(out[j].Availability)
		if left != right {
			return left < right
		}
		if out[i].Load != out[j].Load {
			return out[i].Load < out[j].Load
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// Fleet is the service-level view, so the HTTP layer never reaches past it
// into the registry.
func (s *Service) Fleet() []FleetMember {
	if s == nil || s.Registry == nil {
		return nil
	}
	return s.Registry.Fleet(time.Now())
}
