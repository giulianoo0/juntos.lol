import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import { subtitleFontSize } from './subtitleLayout'

/**
 * Picture-in-picture that keeps the subtitles, which the browser's own PiP
 * drops since they are drawn over the video, not in it. Chrome and Edge open
 * a document window and carry the video and its subtitle layers into it;
 * Safari gets a canvas that composes picture and subtitles every frame,
 * streamed into a hidden video that goes to PiP. Firefox has no PiP API.
 */
export type PipMode = 'document' | 'canvas' | 'none'

interface DocumentPictureInPicture {
  requestWindow(options: { width: number; height: number }): Promise<Window>
}

type PipScope = Window & { documentPictureInPicture?: DocumentPictureInPicture }

export interface PipFeatures {
  videoPip: boolean
  canvasStream: boolean
}

export interface PipSession {
  close(): void
}

interface PipOptions {
  onClose: () => void
  scope?: Window
}

const PIP_WIDTH = 640
const CANVAS_REDRAW_MS = 250
const CANVAS_FALLBACK_FRAME_MS = 33

function browserFeatures(): PipFeatures {
  return {
    videoPip: typeof HTMLVideoElement !== 'undefined'
      && 'requestPictureInPicture' in HTMLVideoElement.prototype
      && document.pictureInPictureEnabled !== false,
    canvasStream: typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype,
  }
}

export function pipMode(scope: Window = window, features: PipFeatures = browserFeatures()): PipMode {
  if ((scope as PipScope).documentPictureInPicture) return 'document'
  if (features.videoPip && features.canvasStream) return 'canvas'
  return 'none'
}

function copyPageLook(target: Document) {
  for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    target.head.append(target.importNode(node, true))
  }
  target.documentElement.className = document.documentElement.className
  const theme = document.documentElement.dataset.theme
  if (theme) target.documentElement.dataset.theme = theme
  target.body.style.margin = '0'
  target.body.style.background = '#000'
}

/**
 * Moves `body` (the video and the layers drawn over it) into a document
 * PiP window and back where it was when the window closes, from either side.
 * The caller keeps `body` as the only child of a node React renders, so
 * React never has to insert a sibling next to it while it is away.
 */
export async function openDocumentPip(body: HTMLElement, { onClose, scope = window }: PipOptions): Promise<PipSession> {
  const api = (scope as PipScope).documentPictureInPicture
  if (!api) throw new Error('document picture-in-picture unavailable')
  const video = body.querySelector('video')
  const ratio = video?.videoWidth && video.videoHeight ? video.videoHeight / video.videoWidth : 9 / 16
  const pipWindow = await api.requestWindow({ width: PIP_WIDTH, height: Math.round(PIP_WIDTH * ratio) })
  const home = body.parentNode
  const next = body.nextSibling
  const style = body.getAttribute('style')
  copyPageLook(pipWindow.document)
  body.setAttribute('style', 'position:relative;display:block;width:100vw;height:100vh;overflow:hidden;background:#000')
  pipWindow.document.body.append(body)

  let open = true
  const restore = () => {
    if (!open) return
    open = false
    if (style === null) body.removeAttribute('style')
    else body.setAttribute('style', style)
    if (home) home.insertBefore(body, next && next.parentNode === home ? next : null)
    onClose()
  }
  pipWindow.addEventListener('pagehide', restore, { once: true })
  return {
    close() {
      if (!open) return
      restore()
      pipWindow.close()
    },
  }
}

/**
 * One PiP frame: the picture, then the subtitles over it — the libass canvas
 * when an ASS track is showing, else the cue lines the VTT layer is showing.
 */
export function drawPipFrame(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, overlay: ParentNode, width: number, height: number) {
  ctx.drawImage(video, 0, 0, width, height)
  const ass = overlay.querySelector<HTMLCanvasElement>('canvas.ass-layer')
  if (ass && ass.width > 0 && ass.height > 0) {
    ctx.drawImage(ass, 0, 0, width, height)
    return
  }
  const lines: string[] = []
  for (const node of overlay.querySelectorAll('.subtitle-line')) {
    for (const line of (node.textContent ?? '').split('\n')) {
      if (line.trim()) lines.push(line.trim())
    }
  }
  if (lines.length === 0) return
  const size = subtitleFontSize(height)
  const lineHeight = size * 1.35
  const bottom = height - height * 0.055
  ctx.font = `italic ${size}px Lato, Inter, ui-sans-serif, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(2, size / 6)
  ctx.strokeStyle = 'rgba(0,0,0,0.9)'
  ctx.fillStyle = '#fff'
  lines.forEach((line, index) => {
    const y = bottom - (lines.length - 1 - index) * lineHeight
    ctx.strokeText(line, width / 2, y)
    ctx.fillText(line, width / 2, y)
  })
}

/**
 * The Safari path: a canvas composed from the video and its subtitles at the
 * video's own frame rate (and a slow redraw while it is paused, for a cue
 * that changes on a seek), streamed into a hidden muted video that goes to
 * PiP. The sound stays with the real video; pausing or playing from the PiP
 * window drives the real video, which reports to the room as any click does.
 */
export async function openCanvasPip(video: HTMLVideoElement, overlay: ParentNode, { onClose }: PipOptions): Promise<PipSession> {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth || 1280
  canvas.height = video.videoHeight || 720
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d unavailable')
  const draw = () => {
    if (video.videoWidth && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
    }
    drawPipFrame(ctx, video, overlay, canvas.width, canvas.height)
  }
  draw()

  const perFrame = typeof video.requestVideoFrameCallback === 'function'
  let frameHandle = 0
  const onFrame = () => {
    draw()
    frameHandle = video.requestVideoFrameCallback(onFrame)
  }
  if (perFrame) frameHandle = video.requestVideoFrameCallback(onFrame)
  const timer = setInterval(draw, perFrame ? CANVAS_REDRAW_MS : CANVAS_FALLBACK_FRAME_MS)

  const stream = (canvas as HTMLCanvasElement & { captureStream(): MediaStream }).captureStream()
  const mirror = document.createElement('video')
  mirror.dataset.pipMirror = ''
  mirror.muted = true
  mirror.playsInline = true
  mirror.srcObject = stream
  mirror.setAttribute('aria-hidden', 'true')
  mirror.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.append(mirror)

  let open = true
  const onMirrorPause = () => { if (open && !video.paused) video.pause() }
  const onMirrorPlay = () => { if (open && video.paused) void video.play().catch(() => undefined) }
  const teardown = () => {
    if (!open) return
    open = false
    clearInterval(timer)
    if (perFrame) video.cancelVideoFrameCallback(frameHandle)
    mirror.removeEventListener('pause', onMirrorPause)
    mirror.removeEventListener('play', onMirrorPlay)
    for (const track of stream.getTracks()) track.stop()
    mirror.srcObject = null
    mirror.remove()
    onClose()
  }
  mirror.addEventListener('leavepictureinpicture', teardown, { once: true })
  try {
    await mirror.play()
    await mirror.requestPictureInPicture()
  } catch (error) {
    teardown()
    throw error
  }
  mirror.addEventListener('pause', onMirrorPause)
  mirror.addEventListener('play', onMirrorPlay)
  return {
    close() {
      if (!open) return
      if (document.pictureInPictureElement === mirror) void document.exitPictureInPicture().catch(teardown)
      else teardown()
    },
  }
}

/**
 * The player's PiP button: `bodyRef` wraps the video and its subtitle
 * layers (and is the only child of a node React renders), `videoRef` is the
 * video inside it.
 */
export function usePictureInPicture(bodyRef: RefObject<HTMLElement | null>, videoRef: RefObject<HTMLVideoElement | null>): {
  mode: PipMode
  active: boolean
  toggle: () => void
} {
  const [mode] = useState<PipMode>(() => pipMode())
  const [active, setActive] = useState(false)
  const sessionRef = useRef<PipSession | null>(null)
  const openingRef = useRef(false)

  const toggle = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close()
      return
    }
    const body = bodyRef.current
    const video = videoRef.current
    if (!body || !video || mode === 'none' || openingRef.current) return
    openingRef.current = true
    let closed = false
    const onClose = () => {
      closed = true
      sessionRef.current = null
      setActive(false)
    }
    const opening = mode === 'document' ? openDocumentPip(body, { onClose }) : openCanvasPip(video, body, { onClose })
    opening
      .then((session) => {
        // The window can be shut before the request settles.
        if (closed) return
        sessionRef.current = session
        setActive(true)
      })
      .catch((error) => console.warn('picture-in-picture failed', error))
      .finally(() => { openingRef.current = false })
  }, [bodyRef, videoRef, mode])

  useEffect(() => () => sessionRef.current?.close(), [])

  return { mode, active, toggle }
}
