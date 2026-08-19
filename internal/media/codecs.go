package media

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"math/bits"
	"os"
	"path/filepath"
	"strings"
)

// aacLCCodec is what the pipeline always publishes audio as, so the codec
// string never has to be discovered.
const aacLCCodec = "mp4a.40.2"

// hvcCRecordBytes is the fixed prefix of an HEVCDecoderConfigurationRecord up
// to and including general_level_idc, which is everything RFC 6381 needs.
const hvcCRecordBytes = 13

// maxInitSegmentBytes bounds the search for the configuration record. Init
// segments carry no samples and run to a few kilobytes.
const maxInitSegmentBytes = 1 << 20

// hevcCodecString renders the RFC 6381 codec string for the HEVC track in an
// fMP4 init segment.
//
// ffmpeg writes no CODECS attribute at all for HEVC, which leaves hls.js
// unable to tell what a variant holds: it cannot check the codec against the
// browser before appending, and its own workaround for engines that mis-report
// HEVC support never engages. The information is in the init segment either
// way, so it is read back from there.
func hevcCodecString(initPath string) (string, error) {
	data, err := os.ReadFile(initPath)
	if err != nil {
		return "", fmt.Errorf("read init segment: %w", err)
	}
	if len(data) > maxInitSegmentBytes {
		data = data[:maxInitSegmentBytes]
	}

	// The four-character code introduces the box, so the record follows it.
	// A payload byte sequence could coincide with it, hence the version check
	// before a match is trusted.
	for offset := 0; ; {
		index := bytes.Index(data[offset:], []byte("hvcC"))
		if index < 0 {
			return "", fmt.Errorf("no hvcC configuration in %s", filepath.Base(initPath))
		}
		start := offset + index + 4
		if start+hvcCRecordBytes <= len(data) && data[start] == 1 {
			return formatHEVCCodec(data[start : start+hvcCRecordBytes]), nil
		}
		offset = offset + index + 4
	}
}

func formatHEVCCodec(record []byte) string {
	profileSpace := (record[1] >> 6) & 0x3
	tier := (record[1] >> 5) & 0x1
	profileIDC := record[1] & 0x1f
	compatibility := uint32(record[2])<<24 | uint32(record[3])<<16 | uint32(record[4])<<8 | uint32(record[5])
	constraints := record[6:12]
	levelIDC := record[12]

	var builder strings.Builder
	builder.WriteString("hvc1.")
	// Profile spaces above zero are spelled with a letter prefix.
	if profileSpace > 0 {
		builder.WriteByte("ABC"[profileSpace-1])
	}
	fmt.Fprintf(&builder, "%d.", profileIDC)
	// RFC 6381 writes the compatibility flags with their bit order reversed.
	fmt.Fprintf(&builder, "%X.", bits.Reverse32(compatibility))
	if tier == 1 {
		builder.WriteByte('H')
	} else {
		builder.WriteByte('L')
	}
	fmt.Fprintf(&builder, "%d", levelIDC)
	// Trailing zero bytes of the constraint flags are omitted.
	trimmed := bytes.TrimRight(constraints, "\x00")
	for _, b := range trimmed {
		builder.WriteString("." + strings.ToUpper(hex.EncodeToString([]byte{b})))
	}
	return builder.String()
}

// annotateMasterCodecs fills in the CODECS attribute of every variant that
// lacks one. A variant with no CODECS is treated by players as "might be
// anything", so an engine that cannot decode it finds out only once appending
// fails, far too late to fall back or to say why.
func annotateMasterCodecs(masterPath, videoCodec string, hasAudio bool) error {
	data, err := os.ReadFile(masterPath)
	if err != nil {
		return fmt.Errorf("read master playlist: %w", err)
	}
	codecs := videoCodec
	if hasAudio {
		codecs += "," + aacLCCodec
	}

	lines := strings.Split(string(data), "\n")
	changed := false
	for index, line := range lines {
		if !strings.HasPrefix(line, "#EXT-X-STREAM-INF:") || strings.Contains(line, "CODECS=") {
			continue
		}
		lines[index] = line + fmt.Sprintf(`,CODECS="%s"`, codecs)
		changed = true
	}
	if !changed {
		return nil
	}

	// A player may be polling this playlist, so it is replaced whole rather
	// than truncated and rewritten in place.
	temp := masterPath + ".codecs"
	if err := os.WriteFile(temp, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		return fmt.Errorf("write annotated playlist: %w", err)
	}
	if err := os.Rename(temp, masterPath); err != nil {
		return fmt.Errorf("publish annotated playlist: %w", err)
	}
	return nil
}

// annotateHEVCMaster is the whole job for one output directory: locate the
// video init segment, read its configuration and stamp the playlist. It is a
// no-op for anything but a copied HEVC track, since ffmpeg labels every codec
// it encodes itself.
func annotateHEVCMaster(hlsDir, masterName, initGlob string, p *ProbeResult) error {
	if p == nil || !p.VideoCopyable || p.VideoCodec != "hevc" {
		return nil
	}
	matches, err := filepath.Glob(filepath.Join(hlsDir, initGlob))
	if err != nil {
		return fmt.Errorf("find init segments: %w", err)
	}
	for _, match := range matches {
		codec, err := hevcCodecString(match)
		if err != nil {
			// Audio-only init segments hold no hvcC; keep looking.
			continue
		}
		return annotateMasterCodecs(filepath.Join(hlsDir, masterName), codec, len(p.Audio) > 0)
	}
	return fmt.Errorf("no HEVC init segment in %s", hlsDir)
}
