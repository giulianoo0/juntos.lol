package media

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"

	"github.com/giulianoo0/ss/internal/room"
)

// externalSubsDir holds the subtitle files that came with the source rather
// than out of it, kept apart from the published set because the two are
// numbered together only once the embedded tracks are known.
const externalSubsDir = "external"

// externalSubsManifest records what those files are, since a file name cannot
// carry a track title.
const externalSubsManifest = "tracks.json"

// publishedSubtitleName is the name the player asks for, by position in the
// room's subtitle list.
func publishedSubtitleName(position int, language string) string {
	if !isSafeLanguage(language) {
		language = "und"
	}
	return "sub_" + strconv.Itoa(position) + "_" + language + ".vtt"
}

// StoreExternalSubtitles publishes sibling subtitles immediately and keeps a
// copy aside for the final merge.
//
// Publishing them straight away is the whole point — they are complete on
// their own and usable long before the video is — but the numbering they get
// here is provisional: the embedded tracks do not exist yet, and when they
// arrive they take the low positions.
func StoreExternalSubtitles(subsDir string, subtitles []SideSubtitle) ([]room.TrackInfo, error) {
	if len(subtitles) == 0 {
		return nil, nil
	}
	keep := filepath.Join(subsDir, externalSubsDir)
	if err := os.MkdirAll(keep, 0o755); err != nil {
		return nil, fmt.Errorf("create external subtitle directory: %w", err)
	}

	tracks := make([]room.TrackInfo, 0, len(subtitles))
	for position, subtitle := range subtitles {
		track := subtitle.Track
		track.Index = position
		if err := os.WriteFile(filepath.Join(keep, strconv.Itoa(position)+".vtt"), subtitle.VTT, 0o644); err != nil {
			return nil, fmt.Errorf("keep external subtitle: %w", err)
		}
		published := filepath.Join(subsDir, publishedSubtitleName(position, track.Language))
		if err := os.WriteFile(published, subtitle.VTT, 0o644); err != nil {
			return nil, fmt.Errorf("publish external subtitle: %w", err)
		}
		tracks = append(tracks, track)
	}

	manifest, err := json.Marshal(tracks)
	if err != nil {
		return nil, fmt.Errorf("encode external subtitle manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(keep, externalSubsManifest), manifest, 0o644); err != nil {
		return nil, fmt.Errorf("write external subtitle manifest: %w", err)
	}
	return tracks, nil
}

// MergeExternalSubtitles renumbers the kept sibling subtitles to sit after the
// embedded ones and returns the room's full subtitle list.
//
// The final ffmpeg pass writes the embedded tracks as sub_0..sub_n-1, and the
// player derives each file name from a track's position in this list. Without
// this step that pass would overwrite the sibling files it knows nothing
// about, and a torrent's subtitles would vanish the moment its download
// finished.
func MergeExternalSubtitles(subsDir string, embedded []room.TrackInfo) ([]room.TrackInfo, error) {
	external, err := loadExternalSubtitles(subsDir)
	if err != nil || len(external) == 0 {
		return embedded, err
	}

	merged := make([]room.TrackInfo, 0, len(embedded)+len(external))
	merged = append(merged, embedded...)
	keep := filepath.Join(subsDir, externalSubsDir)
	for offset, track := range external {
		data, err := os.ReadFile(filepath.Join(keep, strconv.Itoa(track.Index)+".vtt"))
		if err != nil {
			return nil, fmt.Errorf("read kept external subtitle: %w", err)
		}
		position := len(embedded) + offset
		if err := os.WriteFile(filepath.Join(subsDir, publishedSubtitleName(position, track.Language)), data, 0o644); err != nil {
			return nil, fmt.Errorf("republish external subtitle: %w", err)
		}
		track.Index = position
		merged = append(merged, track)
	}
	return merged, nil
}

func loadExternalSubtitles(subsDir string) ([]room.TrackInfo, error) {
	data, err := os.ReadFile(filepath.Join(subsDir, externalSubsDir, externalSubsManifest))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read external subtitle manifest: %w", err)
	}
	var tracks []room.TrackInfo
	if err := json.Unmarshal(data, &tracks); err != nil {
		return nil, fmt.Errorf("decode external subtitle manifest: %w", err)
	}
	return tracks, nil
}
