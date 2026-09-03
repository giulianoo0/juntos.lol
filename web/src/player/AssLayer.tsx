import { memo, type RefObject, useEffect, useRef, useState } from 'react'
import type JASSUB from 'jassub'

import jassubDefaultFont from 'jassub/dist/default.woff2?url'
import jassubWorkerUrl from 'jassub/dist/worker/worker.js?worker&url'

const READY_TIMEOUT_MS = 20_000

// The bundled worker only initialises when a same-origin module imports it:
// spawned by its own URL, the renderer's constructor fails inside the worker
// (abslink reports "Unserializable return value") — cause not pinned down,
// the wrapper is what works in production.
let wrappedWorkerUrl: string | null = null
function workerUrl(): string {
  if (wrappedWorkerUrl === null) {
    const absolute = new URL(jassubWorkerUrl, location.href).href
    const source = `import ${JSON.stringify(absolute)};`
    wrappedWorkerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  }
  return wrappedWorkerUrl
}

interface AssLayerProps {
  videoRef: RefObject<HTMLVideoElement | null>
  subUrl: string
  fontUrls: string[]
  timeOffsetSec: number
  onFailed?: (failed: boolean) => void
}

/**
 * Draws an ASS subtitle track over the video with libass (JASSUB): styles,
 * fonts, positioning and karaoke exactly as authored, all of which the VTT
 * conversion flattens. One renderer per track; a republished document swaps
 * in through the renderer instead of restarting the worker, which takes
 * longer than the fleet's publish cadence.
 */
export const AssLayer = memo(function AssLayer({ videoRef, subUrl, fontUrls, timeOffsetSec, onFailed }: AssLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<JASSUB | null>(null)
  const offsetRef = useRef(timeOffsetSec)
  offsetRef.current = timeOffsetSec
  const subUrlRef = useRef(subUrl)
  subUrlRef.current = subUrl
  const loadedUrlRef = useRef<string | null>(null)
  const swapChainRef = useRef<Promise<void>>(Promise.resolve())
  const swapRef = useRef<((target: JASSUB, url: string) => void) | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || failed) return
    let dead = false
    let renderer: JASSUB | null = null
    const swapTrack = (target: JASSUB, url: string) => {
      swapChainRef.current = swapChainRef.current
        .then(async () => {
          if (dead || rendererRef.current !== target || loadedUrlRef.current === url) return
          await target.renderer.setTrackByUrl(url)
          loadedUrlRef.current = url
          await target.resize(true)
        })
        .catch((error) => console.warn('ASS track swap failed', error))
    }
    swapRef.current = swapTrack
    void (async () => {
      try {
        const { default: Jassub } = await import('jassub')
        if (dead) return
        const initialUrl = subUrlRef.current
        renderer = new Jassub({
          video,
          canvas,
          subUrl: initialUrl,
          fonts: fontUrls,
          workerUrl: workerUrl(),
          availableFonts: { 'liberation sans': jassubDefaultFont },
          defaultFont: 'liberation sans',
          timeOffset: offsetRef.current,
        })
        renderer.timeOffset = offsetRef.current
        await Promise.race([
          renderer.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error('ASS renderer never became ready')), READY_TIMEOUT_MS)),
        ])
        if (dead) return
        rendererRef.current = renderer
        loadedUrlRef.current = initialUrl
        // A region switch during init changed the offset while nothing could take it.
        renderer.timeOffset = offsetRef.current
        onFailed?.(false)
        if (subUrlRef.current !== initialUrl) swapTrack(renderer, subUrlRef.current)
      } catch (error) {
        console.warn('ASS renderer unavailable, falling back to VTT', error)
        if (dead) return
        setFailed(true)
        onFailed?.(true)
      }
    })()
    return () => {
      dead = true
      swapRef.current = null
      rendererRef.current = null
      loadedUrlRef.current = null
      void renderer?.destroy().catch(() => undefined)
    }
  }, [videoRef, canvasRef, fontUrls, failed, onFailed])

  useEffect(() => {
    const renderer = rendererRef.current
    if (renderer && swapRef.current) swapRef.current(renderer, subUrl)
  }, [subUrl])

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.timeOffset = timeOffsetSec
  }, [timeOffsetSec])

  if (failed) return null
  return (
    <canvas
      ref={canvasRef}
      className="ass-layer"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1 }}
      aria-hidden="true"
    />
  )
})
