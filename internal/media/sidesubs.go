package media

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"

	"github.com/giulianoo0/ss/internal/room"
)

// maxSideSubtitles bounds how many sibling subtitle files one torrent can
// contribute, leaving room in the per-room track budget for the ones muxed
// into the video itself.
const maxSideSubtitles = 16

var subtitleExtension = regexp.MustCompile(`(?i)\.(srt|ass|ssa|vtt|sub)$`)

// languageNames maps the words releases spell out to the ISO 639-2 vocabulary
// the muxed tracks already use, so the player labels both alike.
var languageNames = map[string]string{
	"arabic": "ara", "chinese": "chi", "croatian": "hrv", "czech": "cze",
	"danish": "dan", "dutch": "dut", "english": "eng", "finnish": "fin",
	"french": "fre", "german": "ger", "greek": "gre", "hebrew": "heb",
	"hindi": "hin", "hungarian": "hun", "indonesian": "ind", "italian": "ita",
	"japanese": "jpn", "korean": "kor", "norwegian": "nor", "polish": "pol",
	"portuguese": "por", "romanian": "rum", "russian": "rus", "serbian": "srp",
	"spanish": "spa", "swedish": "swe", "thai": "tha", "turkish": "tur",
	"ukrainian": "ukr", "vietnamese": "vie",
}

// shortCodes maps the two-letter codes release names use to the same
// three-letter vocabulary.
var shortCodes = map[string]string{
	"ar": "ara", "cs": "cze", "da": "dan", "de": "ger", "el": "gre", "en": "eng",
	"es": "spa", "fi": "fin", "fr": "fre", "he": "heb", "hi": "hin", "hr": "hrv",
	"hu": "hun", "id": "ind", "it": "ita", "ja": "jpn", "ko": "kor", "nl": "dut",
	"no": "nor", "pl": "pol", "pt": "por", "ro": "rum", "ru": "rus", "sr": "srp",
	"sv": "swe", "th": "tha", "tr": "tur", "uk": "ukr", "vi": "vie", "zh": "chi",
}

var (
	tokenSplit    = regexp.MustCompile(`[._\s()\[\]]+`)
	regionTag     = regexp.MustCompile(`(?i)^[a-z]{2}-[a-z]{2}$`)
	collapseSpace = regexp.MustCompile(`[._]+`)
)

// IsSubtitleFileName reports whether a torrent file is a subtitle worth
// fetching alongside the video.
func IsSubtitleFileName(name string) bool {
	return subtitleExtension.MatchString(name)
}

// SubtitleIdentity reads the language and a human label out of a file name.
// Releases label their subtitles in the name and nowhere else, so this is the
// only signal available.
func SubtitleIdentity(path string) (language, title string) {
	fileName := path
	if index := strings.LastIndexByte(path, '/'); index >= 0 {
		fileName = path[index+1:]
	}
	base := subtitleExtension.ReplaceAllString(fileName, "")

	var tokens []string
	for _, token := range tokenSplit.Split(base, -1) {
		if token == "" {
			continue
		}
		// A hyphen is kept while the token still looks like a region-qualified
		// tag (pt-BR) and split otherwise, so hyphenated titles still tokenize.
		if regionTag.MatchString(token) {
			tokens = append(tokens, token)
			continue
		}
		for _, part := range strings.Split(token, "-") {
			if part != "" {
				tokens = append(tokens, part)
			}
		}
	}

	language = "und"
	// Later tokens win: "Movie.2019.1080p.eng.srt" names the language last,
	// while an early token is far more likely to be part of the title.
	for _, token := range tokens {
		lower := strings.ToLower(token)
		switch {
		case languageNames[lower] != "":
			language = languageNames[lower]
		case isLanguageCode(lower):
			language = lower
		case shortCodes[lower] != "":
			language = shortCodes[lower]
		case regionTag.MatchString(token):
			language = lower
		}
	}

	title = strings.TrimSpace(collapseSpace.ReplaceAllString(base, " "))
	if len(title) > 120 {
		title = title[:120]
	}
	if title == "" {
		title = "Subtitle"
	}
	return language, title
}

func isLanguageCode(value string) bool {
	for _, code := range languageNames {
		if code == value {
			return true
		}
	}
	return false
}

// SideSubtitle is one converted sibling subtitle file, ready to publish.
type SideSubtitle struct {
	Track room.TrackInfo
	VTT   []byte
}

// ConvertSideSubtitles turns the subtitle files shipped next to a video into
// WebVTT.
//
// These files are complete on their own and tiny, so they are usable long
// before the video finishes arriving. Conversion runs through ffmpeg, which
// already understands every format in play, rather than through a second
// hand-written parser that would drift from the muxed path.
func ConvertSideSubtitles(ctx context.Context, workDir string, files map[string][]byte) ([]SideSubtitle, error) {
	if len(files) == 0 {
		return nil, nil
	}
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return nil, fmt.Errorf("create subtitle work directory: %w", err)
	}

	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sortStrings(names)

	converted := make([]SideSubtitle, 0, len(names))
	for _, name := range names {
		if len(converted) >= maxSideSubtitles {
			break
		}
		vtt, err := convertOneSideSubtitle(ctx, workDir, name, files[name])
		if err != nil {
			if ctx.Err() != nil {
				return converted, ctx.Err()
			}
			continue
		}
		language, title := SubtitleIdentity(name)
		converted = append(converted, SideSubtitle{
			Track: room.TrackInfo{
				Index:    len(converted),
				Language: language,
				Title:    title,
				Codec:    "webvtt",
			},
			VTT: vtt,
		})
	}
	return converted, nil
}

func convertOneSideSubtitle(ctx context.Context, workDir, name string, data []byte) ([]byte, error) {
	extension := strings.ToLower(filepath.Ext(name))
	// The name comes from a torrent, so it never reaches the filesystem: a
	// fixed scratch name carries only the extension ffmpeg needs to pick a
	// demuxer.
	input := filepath.Join(workDir, "side_input"+extension)
	output := filepath.Join(workDir, "side_output.vtt")
	defer func() {
		_ = os.Remove(input)
		_ = os.Remove(output)
	}()

	if err := os.WriteFile(input, decodeSubtitleBytes(data), 0o644); err != nil {
		return nil, fmt.Errorf("write subtitle input: %w", err)
	}
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner", "-loglevel", "error", "-y",
		"-i", input, "-c:s", "webvtt", output)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("convert %s: %w: %s", name, err, stderrTail(stderr.Bytes(), ffmpegErrorTailBytes))
	}
	vtt, err := os.ReadFile(output)
	if err != nil {
		return nil, fmt.Errorf("read converted subtitle: %w", err)
	}
	if len(vtt) == 0 {
		return nil, fmt.Errorf("convert %s: empty output", name)
	}
	return vtt, nil
}

// decodeSubtitleBytes normalizes text that claims no encoding. Subtitle files
// are usually UTF-8, but older releases are Windows-1252; invalid UTF-8 means
// the strict reading failed, so fall back rather than store mojibake.
func decodeSubtitleBytes(data []byte) []byte {
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	if utf8.Valid(data) {
		return data
	}
	decoded, err := charmap.Windows1252.NewDecoder().Bytes(data)
	if err != nil {
		return data
	}
	return decoded
}

// sortStrings keeps the conversion order stable so track indexes do not move
// between runs over the same torrent.
func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
