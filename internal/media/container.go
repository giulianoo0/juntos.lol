package media

import (
	"encoding/binary"
	"errors"
	"io"
	"os"
)

// PreviewSeconds is how much media the first preview segment is assumed to
// need. Copied video can only be cut at a source keyframe, and a two-second
// target segment routinely waits for a GOP several times that long, so the
// estimate is deliberately generous: a preview that arrives early is a pleasant
// surprise, one that arrives after the countdown reached zero is a broken
// promise.
const PreviewSeconds = 20

// mp4Brands are the container types whose playability depends on where the
// moov atom sits.
var mp4Brands = map[string]struct{}{
	"ftyp": {},
	"moov": {},
	"mdat": {},
	"free": {},
	"skip": {},
	"wide": {},
	"pnot": {},
	"styp": {},
	"sidx": {},
	"moof": {},
}

// maxContainerScanBytes bounds how far into a file the box walk goes before
// giving up. The interesting boxes are all at the very front.
const maxContainerScanBytes = 64 << 10

// ErrContainerUnknown means the available bytes do not yet answer the question.
var ErrContainerUnknown = errors.New("container layout still unknown")

// NeedsWholeFile reports whether a partially downloaded file can never be
// previewed and only becomes playable once the last byte lands.
//
// An MP4 written without faststart puts its moov atom — the index of every
// sample in the file — after the media data. Nothing in it can be decoded
// before that index arrives, so ffprobe fails on every partial prefix and the
// progressive preview waits for a container header that is, by construction,
// at the other end of the download. Detecting it is what turns an unexplained
// wait into an honest "this one starts when the download finishes".
//
// Matroska interleaves its cues as it goes and always answers false.
func NeedsWholeFile(path string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()

	header := make([]byte, 8)
	if _, err := io.ReadFull(file, header); err != nil {
		return false, ErrContainerUnknown
	}
	if _, isMP4 := mp4Brands[string(header[4:8])]; !isMP4 {
		// Not an MP4 family container, so this failure mode does not apply.
		return false, nil
	}

	offset := int64(0)
	for offset < maxContainerScanBytes {
		if _, err := file.Seek(offset, io.SeekStart); err != nil {
			return false, ErrContainerUnknown
		}
		if _, err := io.ReadFull(file, header); err != nil {
			return false, ErrContainerUnknown
		}
		size := int64(binary.BigEndian.Uint32(header[:4]))
		name := string(header[4:8])
		switch name {
		case "moov":
			// The index precedes the media: this file streams.
			return false, nil
		case "mdat":
			// Media before its index: nothing is decodable until the end.
			return true, nil
		}
		switch {
		case size == 1:
			// A 64-bit size follows the box name.
			extended := make([]byte, 8)
			if _, err := io.ReadFull(file, extended); err != nil {
				return false, ErrContainerUnknown
			}
			size = int64(binary.BigEndian.Uint64(extended))
			if size < 16 {
				return false, ErrContainerUnknown
			}
		case size < 8:
			// Zero means "to end of file", anything else is malformed; either
			// way the walk cannot continue.
			return false, ErrContainerUnknown
		}
		offset += size
	}
	return false, ErrContainerUnknown
}

// PreviewTargetBytes estimates how much of a source has to arrive before the
// first segment can be cut, from the bitrate its own header reports. It
// returns 0 when the duration is unknown, which is the honest answer: no
// estimate at all beats a made-up one.
func PreviewTargetBytes(sourceBytes, durationMs, floorBytes int64) int64 {
	if sourceBytes <= 0 || durationMs <= 0 {
		return 0
	}
	target := sourceBytes * (PreviewSeconds * 1000) / durationMs
	if target < floorBytes {
		target = floorBytes
	}
	if target > sourceBytes {
		target = sourceBytes
	}
	return target
}
