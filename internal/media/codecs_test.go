package media

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// hvcCRecord builds an HEVCDecoderConfigurationRecord prefix the way an fMP4
// init segment carries it.
func hvcCRecord(profileSpaceTier, profileIDC byte, compatibility uint32, constraints []byte, level byte) []byte {
	record := make([]byte, hvcCRecordBytes)
	record[0] = 1
	record[1] = profileSpaceTier | profileIDC
	record[2] = byte(compatibility >> 24)
	record[3] = byte(compatibility >> 16)
	record[4] = byte(compatibility >> 8)
	record[5] = byte(compatibility)
	copy(record[6:12], constraints)
	record[12] = level
	return record
}

func TestFormatHEVCCodec(t *testing.T) {
	tests := []struct {
		name   string
		record []byte
		want   string
	}{
		{
			// Taken byte for byte from an init segment ffmpeg produced here.
			name:   "main profile level 2.0",
			record: []byte{0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3c},
			want:   "hvc1.1.6.L60.90",
		},
		{
			name:   "main at level 3.1, the shape most players document",
			record: hvcCRecord(0x00, 1, 0x60000000, []byte{0xB0}, 93),
			want:   "hvc1.1.6.L93.B0",
		},
		{
			name:   "main 10",
			record: hvcCRecord(0x00, 2, 0x20000000, []byte{0x90}, 120),
			want:   "hvc1.2.4.L120.90",
		},
		{
			name:   "high tier reads H rather than L",
			record: hvcCRecord(0x20, 1, 0x60000000, []byte{0xB0}, 123),
			want:   "hvc1.1.6.H123.B0",
		},
		{
			name:   "all zero constraints are omitted entirely",
			record: hvcCRecord(0x00, 1, 0x60000000, nil, 93),
			want:   "hvc1.1.6.L93",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.want, formatHEVCCodec(tt.record))
		})
	}
}

func TestHEVCCodecStringSkipsAFalseMatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "init.mp4")
	// A payload can spell hvcC by coincidence; only a record announcing
	// configuration version 1 is the real one.
	payload := append([]byte("....hvcC"), make([]byte, 4)...)
	payload = append(payload, []byte("hvcC")...)
	payload = append(payload, hvcCRecord(0x00, 1, 0x60000000, []byte{0xB0}, 93)...)
	require.NoError(t, os.WriteFile(path, payload, 0o644))

	got, err := hevcCodecString(path)
	require.NoError(t, err)
	require.Equal(t, "hvc1.1.6.L93.B0", got)
}

func TestHEVCCodecStringWithoutConfiguration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "audio-init.mp4")
	require.NoError(t, os.WriteFile(path, []byte("no configuration record here"), 0o644))

	_, err := hevcCodecString(path)
	require.Error(t, err)
}

func TestAnnotateMasterCodecs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "master.m3u8")
	// The playlist ffmpeg writes for a copied HEVC track: no CODECS at all.
	playlist := "#EXTM3U\n#EXT-X-VERSION:7\n" +
		`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_audio",NAME="audio_0",DEFAULT=YES,URI="stream_0.m3u8"` + "\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=219271,RESOLUTION=320x180,AUDIO=\"group_audio\"\nstream_1.m3u8\n"
	require.NoError(t, os.WriteFile(path, []byte(playlist), 0o644))

	require.NoError(t, annotateMasterCodecs(path, "hvc1.1.6.L93.B0", true))

	got, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Contains(t, string(got), `CODECS="hvc1.1.6.L93.B0,mp4a.40.2"`)
	// Everything else is left exactly as ffmpeg wrote it.
	require.Contains(t, string(got), "#EXT-X-VERSION:7")
	require.Contains(t, string(got), "stream_1.m3u8")
	require.NoFileExists(t, path+".codecs")
}

func TestAnnotateMasterCodecsWithoutAudio(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "master.m3u8")
	require.NoError(t, os.WriteFile(path,
		[]byte("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=320x180\nstream_0.m3u8\n"), 0o644))

	require.NoError(t, annotateMasterCodecs(path, "hvc1.1.6.L93.B0", false))

	got, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Contains(t, string(got), `CODECS="hvc1.1.6.L93.B0"`)
	require.NotContains(t, string(got), "mp4a")
}

func TestAnnotateMasterCodecsReplacesWhatFFmpegWrote(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "master.m3u8")
	// ffmpeg 7.1 labels a copied HEVC track itself, with a constraint field of
	// an odd digit count that browsers refuse. Ours has to win.
	require.NoError(t, os.WriteFile(path, []byte("#EXTM3U\n"+
		`#EXT-X-STREAM-INF:BANDWIDTH=211200,RESOLUTION=1920x1080,CODECS="hvc1.2.4.L120.B01,mp4a.40.2",AUDIO="group_audio"`+
		"\nstream_1.m3u8\n"), 0o644))

	require.NoError(t, annotateMasterCodecs(path, "hvc1.2.4.L120.90", true))

	got, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Contains(t, string(got), `CODECS="hvc1.2.4.L120.90,mp4a.40.2"`)
	require.NotContains(t, string(got), "B01")
	// Exactly one attribute survives, and the rest of the line is untouched.
	require.Equal(t, 1, strings.Count(string(got), "CODECS="))
	require.Contains(t, string(got), `RESOLUTION=1920x1080`)
	require.Contains(t, string(got), `AUDIO="group_audio"`)
}

func TestAnnotateHEVCMasterOnlyTouchesCopiedHEVC(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "master.m3u8")
	original := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nstream_0.m3u8\n"

	for _, probe := range []*ProbeResult{
		nil,
		{VideoCodec: "h264", VideoCopyable: true},
		// Transcoded output is labelled by ffmpeg itself.
		{VideoCodec: "hevc", VideoCopyable: false},
	} {
		require.NoError(t, os.WriteFile(path, []byte(original), 0o644))
		require.NoError(t, annotateHEVCMaster(dir, "master.m3u8", "init_*.mp4", probe))
		got, err := os.ReadFile(path)
		require.NoError(t, err)
		require.Equal(t, original, string(got))
	}
}

func TestBuildRemuxArgsTagsCopiedHEVC(t *testing.T) {
	hevc := &ProbeResult{VideoCodec: "hevc", VideoCopyable: true}
	args := BuildRemuxArgs("in.mkv", "/out", hevc)
	require.Subset(t, args, []string{"-tag:v:0", "hvc1"})

	// Only a copy needs relabelling, and only for HEVC.
	h264 := BuildRemuxArgs("in.mkv", "/out", &ProbeResult{VideoCodec: "h264", VideoCopyable: true})
	require.NotContains(t, h264, "hvc1")
	transcoded := BuildRemuxArgs("in.mkv", "/out", &ProbeResult{VideoCodec: "hevc"})
	require.NotContains(t, transcoded, "hvc1")
}
