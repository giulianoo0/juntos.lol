import { memo, type RefObject, useEffect, useRef, useState } from 'react'

import { type ContentRect, subtitleFontSize, videoContentRect } from './subtitleLayout'

interface SubtitleLayerProps {
  videoRef: RefObject<HTMLVideoElement | null>
  position: number
  revision: string
}

/**
 * Draws the active cues over the video, in place of the browser: Chrome's
 * native `<track>` style wins over `::cue`, so the track only parses the file
 * and reports which cues are active while the drawing happens here.
 */
export const SubtitleLayer = memo(function SubtitleLayer({ videoRef, position, revision }: SubtitleLayerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<ContentRect | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
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
        bottom: `${rect.top + rect.height * 0.055}px`,
        fontSize: `${subtitleFontSize(rect.height)}px`,
      }
    : undefined
  return <div className="subtitle-layer" ref={hostRef} style={style} aria-hidden="true" />
})
