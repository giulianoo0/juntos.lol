import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react'
import type { CallApi } from './useCall'

const CallContext = createContext<CallApi | null>(null)

/** Makes the room's call reachable from every `<CallVideo>` below it. */
export function CallProvider({ call, children }: { call: CallApi; children: ReactNode }) {
  return <CallContext.Provider value={call}>{children}</CallContext.Provider>
}

/**
 * Someone's camera: mine straight from the local preview (mirrored, as a
 * mirror would show it), anyone else's from the relay onto a canvas. It fills
 * its box; what to show while a camera is off is the tile's business.
 */
export function CallVideo({ memberId, className }: { memberId: string; className?: string }) {
  const call = useContext(CallContext)
  const self = call !== null && call.memberId === memberId
  const attach = call?.attach
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const preview = self ? call.previewStream : null

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = preview
    if (preview) void video.play?.().catch(() => undefined)
  }, [preview])

  const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    attach?.(memberId, canvas)
  }, [attach, memberId])

  if (!call) return null
  if (self) {
    return <video ref={videoRef} className={className} autoPlay playsInline muted style={{ transform: 'scaleX(-1)', objectFit: 'cover', width: '100%', height: '100%' }} />
  }
  return <canvas ref={canvasRef} className={className} style={{ objectFit: 'cover', width: '100%', height: '100%' }} />
}
