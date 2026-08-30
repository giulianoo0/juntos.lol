import { memo, type RefObject, useEffect, useRef, useState } from 'react'
import type JASSUB from 'jassub'

// The renderer's worker and WASM ride the app bundle as hashed assets, so
// the page never fetches them from a CDN and the cache keys follow deploys.
import jassubWorkerUrl from 'jassub/dist/wasm/jassub-worker.js?url'
import jassubWasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url'
import jassubModernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url'
import jassubDefaultFont from 'jassub/dist/default.woff2?url'

interface AssLayerProps {
  videoRef: RefObject<HTMLVideoElement | null>
  /** The full URL of the .ass document to render. */
  subUrl: string
  /** URLs of the fonts the source attached for its scripts. */
  fontUrls: string[]
  /** Seconds added to the element's clock: the region's start in the source
   * timeline, so cues authored in absolute time land on rebased media. */
  timeOffsetSec: number
  /** Tells the caller whether the renderer is running, so the VTT fallback
   * layer stays off exactly while libass is drawing. */
  onActive?: (active: boolean) => void
}

/**
 * Draws an ASS subtitle track over the video with libass (JASSUB): styles,
 * fonts, positioning, karaoke and signs exactly as authored — everything the
 * VTT conversion flattens. One renderer instance per document; the instance
 * dies with the component or when the document changes.
 */
export const AssLayer = memo(function AssLayer({ videoRef, subUrl, fontUrls, timeOffsetSec, onActive }: AssLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<JASSUB | null>(null)
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
          // The bundled fallback face covers scripts that name fonts the
          // source did not attach.
          availableFonts: { 'liberation sans': jassubDefaultFont },
          defaultFont: 'liberation sans',
          timeOffset: timeOffsetSec,
        })
        rendererRef.current = renderer
        await renderer.ready
        if (dead) return
        onActive?.(true)
      } catch (error) {
        console.warn('ASS renderer unavailable, falling back to VTT', error)
        if (!dead) setFailed(true)
      }
    })()
    return () => {
      dead = true
      onActive?.(false)
      rendererRef.current = null
      void renderer?.destroy().catch(() => undefined)
    }
    // A canvas whose control was transferred to the worker cannot be reused:
    // remount the element (via key on the caller) when the document changes.
  }, [videoRef, canvasRef, subUrl, fontUrls, failed, onActive])

  // Region switches move the offset while the renderer lives on.
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
