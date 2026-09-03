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
 * conversion flattens. One renderer instance per document.
 */
export const AssLayer = memo(function AssLayer({ videoRef, subUrl, fontUrls, timeOffsetSec, onFailed }: AssLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<JASSUB | null>(null)
  const offsetRef = useRef(timeOffsetSec)
  offsetRef.current = timeOffsetSec
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || failed) return
    let dead = false
    let renderer: JASSUB | null = null
    void (async () => {
      try {
        const { default: Jassub } = await import('jassub')
        if (dead) return
        renderer = new Jassub({
          video,
          canvas,
          subUrl,
          fonts: fontUrls,
          workerUrl: workerUrl(),
          availableFonts: { 'liberation sans': jassubDefaultFont },
          defaultFont: 'liberation sans',
          timeOffset: offsetRef.current,
        })
        rendererRef.current = renderer
        renderer.timeOffset = offsetRef.current
        await Promise.race([
          renderer.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error('ASS renderer never became ready')), READY_TIMEOUT_MS)),
        ])
        if (dead) return
        onFailed?.(false)
      } catch (error) {
        console.warn('ASS renderer unavailable, falling back to VTT', error)
        if (dead) return
        setFailed(true)
        onFailed?.(true)
      }
    })()
    return () => {
      dead = true
      rendererRef.current = null
      void renderer?.destroy().catch(() => undefined)
    }
  }, [videoRef, canvasRef, subUrl, fontUrls, failed, onFailed])

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.timeOffset = timeOffsetSec
  }, [timeOffsetSec])

  if (failed) return null
  return (
    <canvas
      ref={canvasRef}
      className="ass-layer"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      aria-hidden="true"
    />
  )
})
