/**
 * Reads QR codes off the camera: the browser's own BarcodeDetector where it
 * has one, jsQR on a canvas otherwise (Safari, Firefox). The loop runs
 * until `signal` aborts or `onText` returns true; the camera stops with it.
 */

interface Detector {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>
}

type DetectorClass = new (options: { formats: string[] }) => Detector

const EVERY_MS = 250

/** False when there is no camera to ask for. */
export function canScan(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
}

export async function scanQr(video: HTMLVideoElement, signal: AbortSignal, onText: (text: string) => boolean, onCamera?: () => void): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  const stop = () => { for (const track of stream.getTracks()) track.stop() }
  if (signal.aborted) { stop(); return }
  // The video autoplays, muted and inline, as soon as it has the stream.
  video.srcObject = stream
  onCamera?.()

  const read = await reader(video)
  await new Promise<void>((resolve) => {
    let busy = false
    const finish = () => { window.clearInterval(timer); signal.removeEventListener('abort', finish); stop(); resolve() }
    const timer = window.setInterval(() => {
      if (busy) return
      busy = true
      void read().then((text) => {
        busy = false
        if (text !== null && !signal.aborted && onText(text)) finish()
      }, () => { busy = false })
    }, EVERY_MS)
    signal.addEventListener('abort', finish)
  })
}

async function reader(video: HTMLVideoElement): Promise<() => Promise<string | null>> {
  const Native = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector
  if (Native) {
    const detector = new Native({ formats: ['qr_code'] })
    return async () => (await detector.detect(video))[0]?.rawValue ?? null
  }
  const { default: jsQR } = await import('jsqr')
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  return async () => {
    const { videoWidth: width, videoHeight: height } = video
    if (!context || !width || !height) return null
    canvas.width = width
    canvas.height = height
    context.drawImage(video, 0, 0, width, height)
    const image = context.getImageData(0, 0, width, height)
    return jsQR(image.data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null
  }
}
