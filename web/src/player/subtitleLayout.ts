/** The picture's rectangle inside the element that holds it. */
export interface ContentRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where the picture actually sits inside a `object-fit: contain` video.
 *
 * The element is whatever the layout gave it; the picture keeps its own aspect
 * ratio inside that and leaves bars on two sides. Subtitles belong on the
 * picture, not on the bars — the browser's own cue rendering anchors them that
 * way, and an overlay that anchors to the element instead drifts onto the black
 * as soon as the room is not exactly 16:9.
 */
export function videoContentRect(video: {
  clientWidth: number
  clientHeight: number
  videoWidth: number
  videoHeight: number
}): ContentRect {
  const { clientWidth, clientHeight, videoWidth, videoHeight } = video
  // Before metadata arrives there is no ratio to preserve, and the element is
  // the best answer available.
  if (!videoWidth || !videoHeight || !clientWidth || !clientHeight) {
    return { left: 0, top: 0, width: clientWidth, height: clientHeight }
  }
  const scale = Math.min(clientWidth / videoWidth, clientHeight / videoHeight)
  const width = videoWidth * scale
  const height = videoHeight * scale
  return { left: (clientWidth - width) / 2, top: (clientHeight - height) / 2, width, height }
}

/**
 * Cue text size, as a share of the picture's height.
 *
 * WebVTT sizes cues against the video height for a reason: the same room is
 * watched in a phone-sized box and on a television, and a size in pixels is
 * either unreadable on one or overbearing on the other. The floor keeps a
 * thumbnail-sized player legible.
 */
export function subtitleFontSize(pictureHeight: number): number {
  return Math.max(13, Math.round(pictureHeight * 0.045))
}
