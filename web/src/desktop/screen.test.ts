import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktop, resetDesktopForTests } from '../platform'
import type { EncodedFrame } from '../jlocal/h264Feed'
import { appAudioTrack, appCanCapture, startAppFeed } from './screen'

type Handler = (cmd: string, args: Record<string, unknown>) => unknown
type Internals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  transformCallback: (callback: (message: unknown) => void) => number
  unregisterCallback: (id: number) => void
}

/** The app as the page sees it: Tauri's internals with a real channel registry behind them. */
function installApp(handler: Handler = () => null, features = ['screenCapture']) {
  const callbacks = new Map<number, (message: unknown) => void>()
  const sent = new Map<number, number>()
  let nextId = 1
  const invoke = vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === 'app_hello') return { protocolVersion: 1, version: '0.2.0', compatible: true, features, mediaRoot: 'juntos-media://localhost' }
    return await handler(cmd, args)
  })
  const internals: Internals = {
    invoke,
    transformCallback: (callback) => { const id = nextId++; callbacks.set(id, callback); return id },
    unregisterCallback: (id) => { callbacks.delete(id) },
  }
  ;(window as unknown as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__ = internals
  resetDesktopForTests()
  /** What the Rust side does with `channel.send(Response::new(bytes))`. */
  const send = (channel: unknown, bytes: Uint8Array) => {
    const id = (channel as { id: number }).id
    const index = sent.get(id) ?? 0
    sent.set(id, index + 1)
    callbacks.get(id)?.({ index, message: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  }
  return { invoke, send }
}

function frame(pts: number, flags: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(13 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, payload.length)
  view.setBigUint64(4, BigInt(pts))
  view.setUint8(12, flags)
  out.set(payload, 13)
  return out
}

const KEY = [0, 0, 0, 1, 0x65, 1]
const DELTA = [0, 0, 0, 1, 0x41, 2]
const options = { target: { kind: 'display' as const, id: '1' }, width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 }

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  resetDesktopForTests()
  vi.unstubAllGlobals()
})

describe('app screen feed', () => {
  it('turns the app channel into the same frames as jlocal', async () => {
    let channel: unknown
    const app = installApp((cmd, args) => {
      if (cmd !== 'screen_start') return null
      channel = args.frames
      // The first frames can land before the command answers.
      app.send(channel, frame(1_000, 1, KEY))
      app.send(channel, frame(2_500, 0, DELTA))
      return { width: 1920, height: 1080, fps: 60 }
    })
    const feed = await startAppFeed(options)
    expect(app.invoke).toHaveBeenCalledWith('screen_start', {
      target: { kind: 'display', id: '1' },
      quality: { width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 },
      frames: channel,
    })
    const frames: EncodedFrame[] = []
    feed.open((f) => frames.push(f), () => {})
    await Promise.resolve()
    expect(frames.map((f) => [f.keyframe, f.timestamp])).toEqual([[true, 0], [false, 1_500]])
    app.send(channel, frame(3_000, 0, DELTA))
    expect(frames.at(-1)).toMatchObject({ keyframe: false, timestamp: 2_000 })
  })

  it('a second reader starts on the latest keyframe, on its own clock', async () => {
    let channel: unknown
    const app = installApp((cmd, args) => {
      if (cmd === 'screen_start') channel = args.frames
      return { width: 1920, height: 1080, fps: 60 }
    })
    const feed = await startAppFeed(options)
    app.send(channel, frame(1_000, 1, KEY))
    app.send(channel, frame(2_000, 0, DELTA))
    app.send(channel, frame(3_000, 1, KEY))
    app.send(channel, frame(4_000, 0, DELTA))
    const frames: EncodedFrame[] = []
    feed.open((f) => frames.push(f), () => {})
    await Promise.resolve()
    expect(frames.map((f) => [f.keyframe, f.timestamp])).toEqual([[true, 0], [false, 1_000]])
  })

  it('a reader can close from inside its first frame', async () => {
    let channel: unknown
    const app = installApp((cmd, args) => {
      if (cmd === 'screen_start') channel = args.frames
      return { width: 1920, height: 1080, fps: 60 }
    })
    const feed = await startAppFeed(options)
    app.send(channel, frame(1_000, 1, KEY))
    const onFrame = vi.fn()
    const close = feed.open((f) => { onFrame(f); close() }, () => {})
    await Promise.resolve()
    app.send(channel, frame(2_000, 0, DELTA))
    expect(onFrame).toHaveBeenCalledTimes(1)
  })

  it('ends the feed when the app says the source closed', async () => {
    let channel: unknown
    const app = installApp((cmd, args) => {
      if (cmd === 'screen_start') channel = args.frames
      return { width: 1920, height: 1080, fps: 60 }
    })
    const feed = await startAppFeed(options)
    const onEnd = vi.fn()
    feed.open(() => {}, onEnd)
    await Promise.resolve()
    app.send(channel, frame(1_000, 1, KEY))
    app.send(channel, frame(2_000, 0x2, []))
    app.send(channel, frame(3_000, 0x2, []))
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('a reader that closed hears nothing more', async () => {
    let channel: unknown
    const app = installApp((cmd, args) => {
      if (cmd === 'screen_start') channel = args.frames
      return { width: 1920, height: 1080, fps: 60 }
    })
    const feed = await startAppFeed(options)
    const onFrame = vi.fn()
    const close = feed.open(onFrame, () => {})
    close()
    app.send(channel, frame(1_000, 1, KEY))
    expect(onFrame).not.toHaveBeenCalled()
  })

  it('stops the capture once', async () => {
    const app = installApp(() => ({ width: 1920, height: 1080, fps: 60 }))
    const feed = await startAppFeed(options)
    feed.stop()
    feed.stop()
    await Promise.resolve()
    expect(app.invoke.mock.calls.filter(([cmd]) => cmd === 'screen_stop')).toHaveLength(1)
  })

  it('moves the live capture to another target and quality without a new channel', async () => {
    const app = installApp((cmd) => (cmd === 'screen_start' ? { width: 1920, height: 1080, fps: 60 } : null))
    const feed = await startAppFeed(options)
    await feed.retarget({ target: { kind: 'window', id: '42' }, width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 })
    expect(app.invoke).toHaveBeenCalledWith('screen_switch', { target: { kind: 'window', id: '42' } })
    expect(app.invoke.mock.calls.some(([cmd]) => cmd === 'screen_quality')).toBe(false)
    await feed.retarget({ target: { kind: 'window', id: '42' }, width: 2560, height: 1440, fps: 60, bitrate: 18_000_000 })
    expect(app.invoke).toHaveBeenCalledWith('screen_quality', { quality: { width: 2560, height: 1440, fps: 60, bitrate: 18_000_000 } })
    expect(app.invoke.mock.calls.filter(([cmd]) => cmd === 'screen_switch')).toHaveLength(1)
    expect([feed.width, feed.height]).toEqual([2560, 1440])
    expect(app.invoke.mock.calls.filter(([cmd]) => cmd === 'screen_start')).toHaveLength(1)
    expect(app.invoke.mock.calls.some(([cmd]) => cmd === 'screen_stop')).toBe(false)
  })

  it('names a missing permission in its error', async () => {
    installApp((cmd) => { if (cmd === 'screen_start') throw 'permission: screen recording is off'; return null })
    await expect(startAppFeed(options)).rejects.toThrow(/permission/)
  })
})

describe('app capability', () => {
  it('is offered only when the app says it can capture', async () => {
    installApp(() => null, ['screenCapture'])
    await desktop()
    expect(appCanCapture()).toBe(true)
    installApp(() => null, ['localSource'])
    await desktop()
    expect(appCanCapture()).toBe(false)
  })

  it('is not offered in a browser', () => {
    expect(appCanCapture()).toBe(false)
  })
})

/** Just enough Web Audio to see blocks being scheduled. */
function stubAudio() {
  const started: number[] = []
  const track = { stop: vi.fn() }
  class FakeContext {
    currentTime = 0
    resume = vi.fn(async () => undefined)
    close = vi.fn(async () => undefined)
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [track] } } }
    createBuffer(_channels: number, length: number) {
      const planes = [new Float32Array(length), new Float32Array(length)]
      return { length, getChannelData: (channel: number) => planes[channel] }
    }
    createBufferSource() {
      return { buffer: null, connect: vi.fn(), start: (at: number) => started.push(at) }
    }
  }
  vi.stubGlobal('AudioContext', FakeContext)
  return { started, track }
}

describe('app audio', () => {
  it('sends the new mute list live without restarting audio', async () => {
    stubAudio()
    const app = installApp(() => null)
    const audio = appAudioTrack({ muted: ['spotify'], unmuted: [] })
    expect(audio).not.toBeNull()
    await vi.waitFor(() => expect(app.invoke).toHaveBeenCalledWith('audio_start', expect.objectContaining({ muted: ['spotify'], unmuted: [] })))
    audio!.setMuted({ muted: ['spotify', 'chrome'], unmuted: ['discordptb'] })
    await vi.waitFor(() => expect(app.invoke).toHaveBeenCalledWith('audio_set', { muted: ['spotify', 'chrome'], unmuted: ['discordptb'] }))
    expect(app.invoke.mock.calls.filter(([cmd]) => cmd === 'audio_start')).toHaveLength(1)
    expect(app.invoke.mock.calls.some(([cmd]) => cmd === 'audio_stop')).toBe(false)
    audio!.stop()
    await vi.waitFor(() => expect(app.invoke).toHaveBeenCalledWith('audio_stop', undefined))
  })

  it('plays the app PCM into the track', async () => {
    const { started } = stubAudio()
    let channel: unknown
    const app = installApp((cmd, args) => { if (cmd === 'audio_start') channel = args.pcm; return null })
    const audio = appAudioTrack({ muted: [], unmuted: [] })
    await vi.waitFor(() => expect(channel).toBeDefined())
    // Two 10 ms blocks of s16le stereo make one 20 ms buffer.
    app.send(channel, new Uint8Array(1_920))
    expect(started).toHaveLength(0)
    app.send(channel, new Uint8Array(1_920))
    await vi.waitFor(() => expect(started).toHaveLength(1))
    audio!.stop()
  })
})
