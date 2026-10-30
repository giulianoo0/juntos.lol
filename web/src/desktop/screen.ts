/**
 * Screen sharing through the desktop app: the app captures a display or a
 * window, encodes it to H.264 on the GPU and hands the access units over a
 * Tauri channel in jlocal's wire format, so the page publishes them exactly
 * as it publishes jlocal's. The sound comes the same way, as raw PCM, with
 * the apps the person switched off already left out by the app.
 */
import { desktop, settledDesktop, type DesktopApp } from '../platform'
import { FrameParser, pcmTrack, type EncodedFrame, type H264Feed, type H264FeedOptions, type SystemAudio } from '../jlocal/h264Feed'

export interface AppDisplay { id: string; name: string; width: number; height: number }
export interface AppWindow { id: string; title: string; app: string; icon: string }
export interface AppSources { displays: AppDisplay[]; windows: AppWindow[] }
export interface AppAudioApp { id: string; name: string; icon: string }

/** A GOP that never closes is a broken source; past this many frames it is let go. */
const MAX_REPLAY_FRAMES = 600

/** Whether the app carrying the page captures screens itself; synchronous, for a click. */
export function appCanCapture(): boolean {
  return settledDesktop()?.features.includes('screenCapture') === true
}

async function app(): Promise<DesktopApp> {
  const found = await desktop()
  if (!found) throw new Error('app-capture-unavailable')
  return found
}

/** The app's `code: detail` as the reasons the pickers already tell apart. */
function appError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  const code = detail.split(':')[0].trim()
  return new Error(code === 'permission' ? 'app-capture-permission' : `app-capture-failed: ${detail}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const text = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')
const image = (value: unknown) => (typeof value === 'string' && value.startsWith('data:image/') ? value : '')

function bytes(message: unknown): Uint8Array {
  if (message instanceof ArrayBuffer) return new Uint8Array(message)
  if (ArrayBuffer.isView(message)) return new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
  return Array.isArray(message) ? Uint8Array.from(message as number[]) : new Uint8Array(0)
}

/** What can be shared right now. Never throws: an app that cannot list shows an empty picker. */
export async function appSources(): Promise<AppSources> {
  try {
    const body = await (await app()).invoke<unknown>('screen_sources')
    if (!isRecord(body)) return { displays: [], windows: [] }
    const displays = (Array.isArray(body.displays) ? body.displays : []).filter(isRecord)
      .map((entry) => ({ id: text(entry.id), name: text(entry.name), width: Number(entry.width) || 0, height: Number(entry.height) || 0 }))
      .filter((entry) => entry.id)
    const windows = (Array.isArray(body.windows) ? body.windows : []).filter(isRecord)
      .map((entry) => ({ id: text(entry.id), title: text(entry.title), app: text(entry.app), icon: image(entry.icon) }))
      .filter((entry) => entry.id)
    return { displays, windows }
  } catch {
    return { displays: [], windows: [] }
  }
}

/** A JPEG of the target as a data URL; null when the app could not take one. */
export async function appThumbnail(kind: 'display' | 'window', id: string, width: number): Promise<string | null> {
  try {
    return image(await (await app()).invoke<unknown>('screen_thumbnail', { kind, id, width })) || null
  } catch {
    return null
  }
}

/** The apps making sound now, plus the system's own sounds. Never throws. */
export async function appAudioApps(): Promise<AppAudioApp[]> {
  try {
    const body = await (await app()).invoke<unknown>('audio_apps')
    if (!Array.isArray(body)) return []
    return body.filter(isRecord)
      .map((entry) => ({ id: text(entry.id), name: text(entry.name), icon: image(entry.icon) }))
      .filter((entry) => entry.id && entry.name)
  } catch {
    return []
  }
}

export interface AppFeed extends H264Feed {
  /**
   * Moves the live capture to another target or quality on the same
   * channel; the app sends a keyframe right after. Readers opened from then
   * on start on that keyframe, never on the old source's frames.
   */
  retarget(options: H264FeedOptions): Promise<void>
}

interface Reader {
  take(frame: EncodedFrame): void
  end(): void
}

/**
 * Starts the app's capture. One channel carries the frames however many
 * readers the page opens (the publisher, the preview, one per new viewer
 * track): each reader starts on the latest keyframe, kept since it came, and
 * counts time from it.
 */
export async function startAppFeed(options: H264FeedOptions): Promise<AppFeed> {
  const bridge = await app()
  const { Channel } = await import('@tauri-apps/api/core')
  const parser = new FrameParser()
  const readers = new Set<Reader>()
  let replay: EncodedFrame[] = []
  let ended = false
  const channel = new Channel<ArrayBuffer>((message) => {
    if (ended) return
    for (const frame of parser.push(bytes(message))) {
      if (frame.keyframe) replay = [frame]
      else if (replay.length > 0 && replay.length < MAX_REPLAY_FRAMES) replay.push(frame)
      else replay = []
      for (const reader of readers) reader.take(frame)
    }
    if (!parser.ended) return
    ended = true
    for (const reader of [...readers]) reader.end()
    readers.clear()
  })
  const quality = (from: H264FeedOptions) => ({ width: from.width, height: from.height, fps: from.fps, bitrate: from.bitrate ?? 0 })
  let current = quality(options)
  let target = options.target
  let size: Partial<{ width: number; height: number; fps: number }>
  try {
    size = await bridge.invoke<typeof size>('screen_start', { target, quality: current, frames: channel }) ?? {}
  } catch (error) {
    throw appError(error)
  }
  let stopped = false
  const feed: AppFeed = {
    captureId: null,
    width: size.width ?? current.width,
    height: size.height ?? current.height,
    fps: size.fps ?? current.fps,
    bitrate: current.bitrate,
    open(onFrame, onEnd) {
      let origin: number | null = null
      const reader: Reader = {
        take(frame) {
          if (origin === null) {
            if (!frame.keyframe) return
            origin = frame.timestamp
          }
          onFrame({ ...frame, timestamp: frame.timestamp - origin })
        },
        end: onEnd,
      }
      if (ended) { onEnd(); return () => undefined }
      for (const frame of replay) reader.take(frame)
      readers.add(reader)
      return () => { readers.delete(reader) }
    },
    async retarget(next) {
      const wanted = quality(next)
      try {
        if (next.target.kind !== target.kind || next.target.id !== target.id) {
          replay = []
          target = next.target
          await bridge.invoke('screen_switch', { target })
        }
        if (JSON.stringify(wanted) !== JSON.stringify(current)) {
          replay = []
          current = wanted
          const resized = await bridge.invoke<typeof size>('screen_quality', { quality: current }) ?? {}
          feed.width = resized.width ?? current.width
          feed.height = resized.height ?? current.height
          feed.fps = resized.fps ?? current.fps
          feed.bitrate = current.bitrate
        }
      } catch (error) {
        throw appError(error)
      }
    },
    stop() {
      if (stopped) return
      stopped = true
      readers.clear()
      void bridge.invoke('screen_stop').catch(() => undefined)
    },
  }
  return feed
}

/** The apps left out, and the Discords let in anyway (the app keeps every other one out). */
export interface SoundRule {
  muted: readonly string[]
  unmuted: readonly string[]
}

export interface AppAudio extends SystemAudio {
  /** The apps left out from now on; the sound keeps flowing while the app swaps them. */
  setMuted(rule: SoundRule): void
}

const ruleArgs = (rule: SoundRule) => ({ muted: [...rule.muted], unmuted: [...rule.unmuted] })

/** The app's mix of every sounding app but the muted ones, as a track. */
export function appAudioTrack(rule: SoundRule): AppAudio | null {
  let latest = ruleArgs(rule)
  let started: Promise<DesktopApp | null> | null = null
  const audio = pcmTrack((push, signal) => {
    started = (async () => {
      const bridge = await desktop()
      if (!bridge || signal.aborted) return null
      const { Channel } = await import('@tauri-apps/api/core')
      const pcm = new Channel<ArrayBuffer>((message) => push(bytes(message)))
      await bridge.invoke('audio_start', { ...latest, pcm })
      return bridge
    })().catch(() => null)
  })
  if (!audio) return null
  return {
    track: audio.track,
    setMuted(next) {
      latest = ruleArgs(next)
      void started?.then((bridge) => bridge?.invoke('audio_set', latest)).catch(() => undefined)
    },
    stop() {
      audio.stop()
      void started?.then((bridge) => bridge?.invoke('audio_stop')).catch(() => undefined)
    },
  }
}
