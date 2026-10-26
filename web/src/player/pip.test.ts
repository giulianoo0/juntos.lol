import { afterEach, describe, expect, it, vi } from 'vitest'
import { drawPipFrame, openCanvasPip, openDocumentPip, pipMode } from './pip'

afterEach(() => {
  document.body.replaceChildren()
  document.head.querySelectorAll('style[data-pip-test]').forEach((node) => node.remove())
})

function playerBody(): { slot: HTMLElement; body: HTMLElement; video: HTMLVideoElement } {
  const slot = document.createElement('div')
  const body = document.createElement('div')
  const video = document.createElement('video')
  Object.defineProperty(video, 'videoWidth', { value: 1920 })
  Object.defineProperty(video, 'videoHeight', { value: 800 })
  body.append(video)
  slot.append(body)
  document.body.append(slot)
  return { slot, body, video }
}

function fakePipWindow() {
  const doc = document.implementation.createHTMLDocument('pip')
  const listeners = new Map<string, () => void>()
  const pipWindow = {
    document: doc,
    close: vi.fn(() => listeners.get('pagehide')?.()),
    addEventListener: vi.fn((type: string, fn: () => void) => listeners.set(type, fn)),
  }
  return { pipWindow, doc, listeners }
}

describe('pipMode', () => {
  it('prefers a document window, then a canvas stream, then nothing', () => {
    const withDocument = { documentPictureInPicture: { requestWindow: vi.fn() } } as unknown as Window
    expect(pipMode(withDocument, { videoPip: true, canvasStream: true })).toBe('document')
    expect(pipMode({} as Window, { videoPip: true, canvasStream: true })).toBe('canvas')
    expect(pipMode({} as Window, { videoPip: false, canvasStream: true })).toBe('none')
    expect(pipMode({} as Window, { videoPip: true, canvasStream: false })).toBe('none')
  })
})

describe('openDocumentPip', () => {
  it('carries the video and its layers into the window with the page styles, and puts them back on close', async () => {
    const style = document.createElement('style')
    style.dataset.pipTest = ''
    style.textContent = '.video { width: 100%; }'
    document.head.append(style)
    const { slot, body } = playerBody()
    const { pipWindow, doc } = fakePipWindow()
    const requestWindow = vi.fn().mockResolvedValue(pipWindow)
    const onClose = vi.fn()

    const session = await openDocumentPip(body, { onClose, scope: { documentPictureInPicture: { requestWindow } } as unknown as Window })

    expect(requestWindow).toHaveBeenCalledWith({ width: 640, height: 267 })
    expect(doc.body.contains(body)).toBe(true)
    expect(slot.contains(body)).toBe(false)
    expect(doc.head.textContent).toContain('.video { width: 100%; }')

    session.close()
    expect(pipWindow.close).toHaveBeenCalled()
    expect(slot.firstChild).toBe(body)
    expect(body.getAttribute('style')).toBeNull()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('brings the player home when the person closes the window', async () => {
    const { slot, body } = playerBody()
    const { pipWindow, listeners } = fakePipWindow()
    const onClose = vi.fn()
    await openDocumentPip(body, {
      onClose,
      scope: { documentPictureInPicture: { requestWindow: vi.fn().mockResolvedValue(pipWindow) } } as unknown as Window,
    })
    listeners.get('pagehide')?.()
    expect(slot.firstChild).toBe(body)
    expect(onClose).toHaveBeenCalledOnce()
  })
})

function fakeContext() {
  return {
    drawImage: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
    font: '',
    textAlign: '',
    textBaseline: '',
    lineJoin: '',
    lineWidth: 0,
    fillStyle: '',
    strokeStyle: '',
  }
}

describe('drawPipFrame', () => {
  it('draws the picture and then the libass canvas over it', () => {
    const { body, video } = playerBody()
    const ass = document.createElement('canvas')
    ass.className = 'ass-layer'
    ass.width = 960
    ass.height = 400
    body.append(ass)
    const ctx = fakeContext()
    drawPipFrame(ctx as unknown as CanvasRenderingContext2D, video, body, 1920, 800)
    expect(ctx.drawImage.mock.calls).toEqual([[video, 0, 0, 1920, 800], [ass, 0, 0, 1920, 800]])
    expect(ctx.fillText).not.toHaveBeenCalled()
  })

  it('writes the showing cue lines at the bottom when there is no libass canvas', () => {
    const { body, video } = playerBody()
    const layer = document.createElement('div')
    layer.className = 'subtitle-layer'
    for (const text of ['Primeira linha', 'Segunda']) {
      const line = document.createElement('div')
      line.className = 'subtitle-line'
      line.textContent = text
      layer.append(line)
    }
    body.append(layer)
    const ctx = fakeContext()
    drawPipFrame(ctx as unknown as CanvasRenderingContext2D, video, body, 1920, 800)
    expect(ctx.drawImage).toHaveBeenCalledOnce()
    expect(ctx.fillText.mock.calls.map((call) => call[0])).toEqual(['Primeira linha', 'Segunda'])
    const [, , firstY] = ctx.fillText.mock.calls[0]
    const [, , secondY] = ctx.fillText.mock.calls[1]
    expect(secondY).toBeGreaterThan(firstY)
    expect(secondY).toBeLessThan(800)
  })
})

describe('openCanvasPip', () => {
  it('streams the composed canvas into a hidden video and tears it down when the window goes', async () => {
    const { body, video } = playerBody()
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
    const ctx = fakeContext()
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: vi.fn(() => stream) })
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const requestPictureInPicture = vi.fn().mockResolvedValue({})
    Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { configurable: true, value: requestPictureInPicture })
    const onClose = vi.fn()

    const session = await openCanvasPip(video, body, { onClose })

    const hidden = document.querySelector('video[data-pip-mirror]') as HTMLVideoElement
    expect(hidden).not.toBeNull()
    expect(hidden.srcObject).toBe(stream)
    expect(hidden.muted).toBe(true)
    expect(requestPictureInPicture).toHaveBeenCalled()
    expect(ctx.drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 800)

    hidden.dispatchEvent(new Event('leavepictureinpicture'))
    expect(stop).toHaveBeenCalled()
    expect(document.querySelector('video[data-pip-mirror]')).toBeNull()
    expect(onClose).toHaveBeenCalledOnce()
    session.close()
    expect(onClose).toHaveBeenCalledOnce()

    getContext.mockRestore()
    play.mockRestore()
  })
})
