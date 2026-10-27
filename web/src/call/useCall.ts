import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { audioLocked } from '../ui/audioUnlock'
import { relayPublishSupported } from './moq'
import { fetchCallRelay, localLevel, openCallWatch, publishCall, type CallPublisher, type CallRelay, type CallWatchSession, type MemberWatch } from './media'
import { hearable, viewable, type CallMember } from './plan'
import { SpeakingDetector, voiceLevel } from './speaking'
import { SubscriptionPool, type WatchStatus } from './subscriptions'
import { useLocalMedia, type DeviceKind, type LocalMediaError } from './useLocalMedia'
import type { DeviceLists, DevicePrefs } from './devices'

/** What the call sends over the room's socket. */
export type CallMessage =
  | { type: 'media'; mic: boolean; cam: boolean }
  | { type: 'hostMute'; targetId: string }
  | { type: 'hostCamOff'; targetId: string }

export interface CallOptions {
  roomId: string
  memberId: string
  capability: string
  /** The room socket's send. */
  send(message: CallMessage): void
  /** The room's members as the socket last listed them. */
  members: CallMember[]
  /** What the entry screen left switched on. */
  initial?: { mic?: boolean; cam?: boolean }
}

export interface CallApi {
  /** Whether this browser can send a camera and voice (WebKit only watches, through the bridge). */
  supported: boolean
  mic: boolean
  cam: boolean
  setMic(on: boolean): void
  setCam(on: boolean): void
  devices: DeviceLists
  selected: DevicePrefs
  setDevice(kind: DeviceKind, deviceId: string): void
  /** My camera, for my own tile and the entry screen. */
  previewStream: MediaStream | null
  /** Who is talking right now, me included; absent means silent. */
  speaking: Record<string, boolean>
  /** 0..1, how loud a voice is right now (mine included); 0 for one not heard. */
  levelOf(memberId: string): number
  /** What the host turned off for me and I have not turned back on. */
  forced: { mic: boolean; cam: boolean }
  error: LocalMediaError | null
  /** Hands the call a socket message; it acts on `forceMedia` and ignores the rest. */
  receive(message: { type: string; mic?: boolean; cam?: boolean }): void
  /** The host's controls over someone else. */
  hostMute(memberId: string): void
  hostCamOff(memberId: string): void
  memberId: string
  /** Each remote broadcast's subscription state. */
  status: Record<string, WatchStatus>
  /** Binds a member's camera to a canvas, or unbinds it on null. `<CallVideo>` does this. */
  attach(memberId: string, canvas: HTMLCanvasElement | null): void
}

/** How often the voices' levels are read for the speaking rings. */
const LEVEL_EVERY_MS = 100
/** How often a broadcast that has not gone live is looked at again. */
const WATCH_TICK_MS = 1_000
/** How long a voice the room says is on may go without a single sample before it is reopened. */
const AUDIO_STALL_MS = 5_000
/** A call reconnects sooner than a screen: there is no 4K keyframe to wait for. */
const CALL_RETRY = { retryMs: 4_000, loadingRetryMs: 6_000, gapMs: 1_500 }

/**
 * Everything a member's camera and voice need in a room: turning them on and
 * off, publishing them, hearing everyone whose microphone is on, painting the
 * cameras the page shows, and who is speaking.
 *
 * The room list decides the subscriptions: a voice is heard while its member
 * says the microphone is on and the host has not muted them, and a camera is
 * downloaded while it is on, not turned off by the host, and bound to a tile
 * that is on screen.
 */
export function useCall({ roomId, memberId, capability, send, members, initial }: CallOptions): CallApi {
  const local = useLocalMedia(initial)
  const supported = useMemo(() => relayPublishSupported(), [])
  const [relay, setRelay] = useState<CallRelay | null>(null)
  const [session, setSession] = useState<CallWatchSession | null>(null)
  const [publisher, setPublisher] = useState<CallPublisher | null>(null)
  const [forced, setForced] = useState({ mic: false, cam: false })
  const [speaking, setSpeaking] = useState<Record<string, boolean>>({})
  const [status, setStatus] = useState<Record<string, WatchStatus>>({})
  const canvasesRef = useRef(new Map<string, HTMLCanvasElement>())
  const [canvasVersion, setCanvasVersion] = useState(0)
  const sessionRef = useRef<CallWatchSession | null>(null)
  sessionRef.current = session
  const sendRef = useRef(send)
  sendRef.current = send

  useEffect(() => {
    if (!memberId || !capability) return
    let disposed = false
    void fetchCallRelay(roomId, memberId, capability).then((next) => { if (!disposed) setRelay(next) }).catch(() => undefined)
    return () => { disposed = true }
  }, [roomId, memberId, capability])

  useEffect(() => {
    if (!relay) return
    let disposed = false
    let opened: CallWatchSession | null = null
    void openCallWatch(relay).then((next) => {
      if (disposed) { next.close(); return }
      opened = next
      setSession(next)
    }).catch(() => undefined)
    return () => {
      disposed = true
      opened?.close()
      setSession(null)
    }
  }, [relay])

  useEffect(() => { session?.setSpeaker(local.selected.speaker) }, [session, local.selected.speaker])

  // My broadcast goes up with the first thing I switch on and stays for the
  // whole call; a new member id (a socket that came back as someone new) gets
  // a new path.
  const [broadcasting, setBroadcasting] = useState(false)
  useEffect(() => { if (local.mic || local.cam) setBroadcasting(true) }, [local.mic, local.cam])
  useEffect(() => {
    if (!relay || !supported || !broadcasting) return
    let disposed = false
    let opened: CallPublisher | null = null
    void publishCall(relay).then(async (next) => {
      if (disposed) { next.close(); return }
      opened = next
      // The room hears about my devices only once the relay has the
      // broadcast: a viewer that subscribes earlier finds nothing there.
      await next.ready
      if (!disposed) setPublisher(next)
    }).catch(() => undefined)
    return () => {
      disposed = true
      opened?.close()
      setPublisher(null)
    }
  }, [relay, supported, broadcasting])

  useEffect(() => { publisher?.setMic(local.micTrack ?? undefined) }, [publisher, local.micTrack])
  useEffect(() => { publisher?.setCam(local.camTrack ?? undefined) }, [publisher, local.camTrack])

  const live = publisher !== null
  useEffect(() => {
    if (!memberId) return
    sendRef.current({ type: 'media', mic: live && local.mic, cam: live && local.cam })
  }, [memberId, live, local.mic, local.cam])

  // Which broadcasts to hold, and what of each: voices from the room list,
  // cameras from the tiles bound right now.
  const voices = useMemo(() => new Set(hearable(members, memberId)), [members, memberId])
  const voicesRef = useRef(voices)
  voicesRef.current = voices
  const planRef = useRef({ voices, members })
  planRef.current = { voices, members }
  const shape = useCallback((target: string, watch: MemberWatch) => {
    const plan = planRef.current
    watch.setAudio(plan.voices.has(target))
    watch.setCanvas(viewable(plan.members, target) ? canvasesRef.current.get(target) ?? null : null)
  }, [])

  const [pool] = useState(() => new SubscriptionPool<MemberWatch>({
    open: (target) => {
      const current = sessionRef.current
      if (!current) return null
      const watch = current.watch(target)
      shape(target, watch)
      return Promise.resolve(watch)
    },
    ...CALL_RETRY,
    onStatus: (target, next) => setStatus((all) => {
      if (next === undefined) {
        if (!(target in all)) return all
        const rest = { ...all }
        delete rest[target]
        return rest
      }
      return all[target] === next ? all : { ...all, [target]: next }
    }),
  }))

  useEffect(() => {
    if (session) pool.refresh()
  }, [session, pool])

  // A voice the room says is on but whose samples stopped coming is stuck,
  // not quiet: the encoder sends silence too. It is opened again.
  useEffect(() => {
    const heard = new Map<string, { at: number | undefined; since: number }>()
    const timer = setInterval(() => {
      pool.tick()
      if (audioLocked()) return
      const now = performance.now()
      for (const target of [...heard.keys()]) if (!voicesRef.current.has(target)) heard.delete(target)
      for (const target of voicesRef.current) {
        const watch = pool.get(target)
        if (!watch) { heard.delete(target); continue }
        const at = watch.audioAt()
        const last = heard.get(target)
        if (!last || last.at !== at) { heard.set(target, { at, since: now }); continue }
        if (now - last.since < AUDIO_STALL_MS) continue
        heard.delete(target)
        watch.reopenAudio()
      }
    }, WATCH_TICK_MS)
    return () => clearInterval(timer)
  }, [pool])

  useEffect(() => () => pool.close(), [pool])

  useEffect(() => {
    const wanted = new Set(voices)
    for (const target of canvasesRef.current.keys()) {
      if (target !== memberId && viewable(members, target)) wanted.add(target)
    }
    // A broadcast already held stays held while its member is in the room:
    // subscribing again to one just let go is what the relay is slowest at.
    const present = new Set(members.map((member) => member.id))
    for (const target of pool.keys()) {
      if (present.has(target) && target !== memberId) wanted.add(target)
      else pool.drop(target)
    }
    for (const target of wanted) pool.want(target)
    for (const target of wanted) {
      const watch = pool.get(target)
      if (watch) shape(target, watch)
    }
  }, [voices, members, memberId, pool, shape, canvasVersion])

  const attach = useCallback((target: string, canvas: HTMLCanvasElement | null) => {
    const canvases = canvasesRef.current
    if (canvas) {
      if (canvases.get(target) === canvas) return
      canvases.set(target, canvas)
    } else {
      if (!canvases.has(target)) return
      pool.get(target)?.setCanvas(null)
      canvases.delete(target)
    }
    setCanvasVersion((version) => version + 1)
  }, [pool])

  // Speaking rings: every voice I hear, and my own microphone.
  const detectorsRef = useRef(new Map<string, SpeakingDetector>())
  const selfMeterRef = useRef<{ level(): number; close(): void } | null>(null)
  useEffect(() => {
    if (!local.micTrack) return
    const meter = localLevel(local.micTrack)
    selfMeterRef.current = meter
    return () => {
      meter.close()
      if (selfMeterRef.current === meter) selfMeterRef.current = null
    }
  }, [local.micTrack])

  useEffect(() => {
    const timer = setInterval(() => {
      const now = performance.now()
      const next: Record<string, boolean> = {}
      const levels: Array<[string, number]> = [...voices].map((target) => [target, pool.get(target)?.level() ?? 0])
      if (selfMeterRef.current) levels.push([memberId, selfMeterRef.current.level()])
      for (const [target, level] of levels) {
        let detector = detectorsRef.current.get(target)
        if (!detector) { detector = new SpeakingDetector(); detectorsRef.current.set(target, detector) }
        if (detector.update(level, now)) next[target] = true
      }
      for (const target of detectorsRef.current.keys()) if (!levels.some(([id]) => id === target)) detectorsRef.current.delete(target)
      setSpeaking((current) => {
        const keys = Object.keys(next)
        return keys.length === Object.keys(current).length && keys.every((key) => current[key]) ? current : next
      })
    }, LEVEL_EVERY_MS)
    return () => clearInterval(timer)
  }, [voices, pool, memberId])

  const levelOf = useCallback((target: string) => {
    const level = target === memberId ? selfMeterRef.current?.level() : pool.get(target)?.level()
    return voiceLevel(level ?? 0)
  }, [pool, memberId])

  const { setMic: setLocalMic, setCam: setLocalCam } = local
  const setMic = useCallback((on: boolean) => {
    if (on) setForced((current) => (current.mic ? { ...current, mic: false } : current))
    void setLocalMic(on)
  }, [setLocalMic])
  const setCam = useCallback((on: boolean) => {
    if (on) setForced((current) => (current.cam ? { ...current, cam: false } : current))
    void setLocalCam(on)
  }, [setLocalCam])

  const receive = useCallback((message: { type: string; mic?: boolean; cam?: boolean }) => {
    if (message.type !== 'forceMedia') return
    if (message.mic === false) {
      setForced((current) => ({ ...current, mic: true }))
      void setLocalMic(false)
    }
    if (message.cam === false) {
      setForced((current) => ({ ...current, cam: true }))
      void setLocalCam(false)
    }
  }, [setLocalMic, setLocalCam])

  const hostMute = useCallback((targetId: string) => sendRef.current({ type: 'hostMute', targetId }), [])
  const hostCamOff = useCallback((targetId: string) => sendRef.current({ type: 'hostCamOff', targetId }), [])

  return {
    supported,
    mic: local.mic,
    cam: local.cam,
    setMic,
    setCam,
    devices: local.devices,
    selected: local.selected,
    setDevice: local.setDevice,
    previewStream: local.previewStream,
    speaking,
    levelOf,
    forced,
    error: local.error,
    receive,
    hostMute,
    hostCamOff,
    memberId,
    status,
    attach,
  }
}
