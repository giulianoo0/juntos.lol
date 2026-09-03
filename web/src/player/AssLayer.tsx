import { memo, type RefObject, useEffect, useRef, useState } from 'react'
import type JASSUB from 'jassub'

import jassubWorkerUrl from 'jassub/dist/wasm/jassub-worker.js?url'
import jassubWasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url'
import jassubModernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url'
import jassubDefaultFont from 'jassub/dist/default.woff2?url'

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
          workerUrl: jassubWorkerUrl,
          wasmUrl: jassubWasmUrl,
          modernWasmUrl: jassubModernWasmUrl,
          availableFonts: { 'liberation sans': jassubDefaultFont },
          defaultFont: 'liberation sans',
          timeOffset: offsetRef.current,
        })
        rendererRef.current = renderer
        renderer.timeOffset = offsetRef.current
        await renderer.ready
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
