import { memo, type RefObject, useEffect, useRef, useState } from 'react'

import { type ContentRect, subtitleFontSize, videoContentRect } from './subtitleLayout'

interface SubtitleLayerProps {
  videoRef: RefObject<HTMLVideoElement | null>
  /** Position of the chosen track in video.textTracks, or -1 for none. */
  position: number
  /** Changes when the track elements are rebuilt, so the listener re-attaches. */
  revision: string
}

/**
 * Draws the active cues over the video, in place of the browser.
 *
 * Chrome renders a native `<track>` with the operating system's caption style,
 * and that style wins over the page: `::cue { background }` is ignored no
 * matter how it is written, so the room cannot get rid of the black slab or
 * the tight line box that clips descenders — a "j" or a "y" is cut off. The
 * track still parses the file and still reports which cues are active; only
 * the drawing moves here.
 */
export const SubtitleLayer = memo(function SubtitleLayer({ videoRef, position, revision }: SubtitleLayerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<ContentRect | null>(null)

  // The picture moves whenever the element resizes, fullscreen toggles, or a
  // new source arrives with a different aspect ratio.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    // The chat column closing animates the video's width for 250ms, and the
    // observer reports every frame of it. Coalescing to one measurement per
    // frame — and dropping the ones that name the same box — turns a burst of
    // renders into the two that actually change anything.
    let frame = 0
    const apply = () => {
      frame = 0
      const next = videoContentRect(video)
      setRect((prev) => (
        prev && next && prev.left === next.left && prev.top === next.top
          && prev.width === next.width && prev.height === next.height
          ? prev
          : next
      ))
    }
    const measure = () => {
      if (frame) return
      frame = requestAnimationFrame(apply)
    }
    apply()
    const observer = new ResizeObserver(measure)
    observer.observe(video)
    video.addEventListener('loadedmetadata', measure)
    video.addEventListener('resize', measure)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      video.removeEventListener('loadedmetadata', measure)
      video.removeEventListener('resize', measure)
    }
  }, [videoRef])

  useEffect(() => {
    const video = videoRef.current
    const host = hostRef.current
    if (!video || !host) return
    const track = position >= 0 ? video.textTracks?.[position] : undefined

    const draw = () => {
      host.replaceChildren()
      const cues = track?.activeCues
      if (!cues) return
      for (let index = 0; index < cues.length; index += 1) {
        const cue = cues[index] as VTTCue
        const line = document.createElement('div')
        line.className = 'subtitle-line'
        // getCueAsHTML keeps the markup the extraction emits: <i>, <b> and the
        // colour classes, which arrive as spans carrying the class name.
        if (typeof cue.getCueAsHTML === 'function') line.append(cue.getCueAsHTML())
        else line.textContent = cue.text ?? ''
        host.append(line)
      }
    }

    draw()
    track?.addEventListener('cuechange', draw)
    return () => {
      track?.removeEventListener('cuechange', draw)
      host.replaceChildren()
    }
  }, [videoRef, position, revision])

  if (position < 0) return null
  const style = rect
    ? {
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        // Sits a little above the picture's bottom edge, where a caption goes.
        bottom: `${rect.top + rect.height * 0.055}px`,
        fontSize: `${subtitleFontSize(rect.height)}px`,
      }
    : undefined
  return <div className="subtitle-layer" ref={hostRef} style={style} aria-hidden="true" />
})
