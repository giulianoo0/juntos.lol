/** The picture's rectangle inside the element that holds it. */
export interface ContentRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where the picture actually sits inside an `object-fit: contain` video:
 * subtitles belong on the picture, not on the bars the aspect ratio leaves.
 */
export function videoContentRect(video: {
  clientWidth: number
  clientHeight: number
  videoWidth: number
  videoHeight: number
}): ContentRect {
  const { clientWidth, clientHeight, videoWidth, videoHeight } = video
  if (!videoWidth || !videoHeight || !clientWidth || !clientHeight) {
    return { left: 0, top: 0, width: clientWidth, height: clientHeight }
  }
  const scale = Math.min(clientWidth / videoWidth, clientHeight / videoHeight)
  const width = videoWidth * scale
  const height = videoHeight * scale
  return { left: (clientWidth - width) / 2, top: (clientHeight - height) / 2, width, height }
}

/**
 * Cue text size, as a share of the picture's height: a size in pixels is either
 * unreadable in a phone-sized box or overbearing on a television. The floor
 * keeps a thumbnail-sized player legible.
 */
export function subtitleFontSize(pictureHeight: number): number {
  return Math.max(13, Math.round(pictureHeight * 0.045))
}
