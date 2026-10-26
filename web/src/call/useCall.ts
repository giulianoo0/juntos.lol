import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { relayPublishSupported } from './moq'
import { fetchCallRelay, localLevel, openCallWatch, publishCall, type CallPublisher, type CallRelay, type CallWatchSession, type MemberWatch } from './media'
import { hearable, viewable, type CallMember } from './plan'
import { SpeakingDetector } from './speaking'
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
    void publishCall(relay).then((next) => {
      if (disposed) { next.close(); return }
      opened = next
      setPublisher(next)
    }).catch(() => undefined)
    return () => {
      disposed = true
      opened?.close()
      setPublisher(null)
    }
  }, [relay, supported, broadcasting])

  useEffect(() => { publisher?.setMic(local.micTrack ?? undefined) }, [publisher, local.micTrack])
  useEffect(() => { publisher?.setCam(local.camTrack ?? undefined) }, [publisher, local.camTrack])

  useEffect(() => {
    if (!memberId) return
    sendRef.current({ type: 'media', mic: local.mic, cam: local.cam })
  }, [memberId, local.mic, local.cam])

  // Which broadcasts to hold, and what of each: voices from the room list,
  // cameras from the tiles bound right now.
  const voices = useMemo(() => new Set(hearable(members, memberId)), [members, memberId])
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

  useEffect(() => {
    const timer = setInterval(() => pool.tick(), WATCH_TICK_MS)
    return () => {
      clearInterval(timer)
    }
  }, [pool])

  useEffect(() => () => pool.close(), [pool])

  useEffect(() => {
    const wanted = new Set(voices)
    for (const target of canvasesRef.current.keys()) {
      if (target !== memberId && viewable(members, target)) wanted.add(target)
    }
    for (const target of pool.keys()) if (!wanted.has(target)) pool.drop(target)
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
