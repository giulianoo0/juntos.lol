import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ScreenShareInfo } from '../types'
import {
  fetchScreenRelay,
  isScreenShareCancelled,
  loadScreenQuality,
  publishScreen,
  requestScreenStream,
  saveScreenQuality,
  screenQuality,
  screenPath,
  screenShareSupported,
  setScreenLive,
  setScreenShareOpen,
  takeScreenStream,
  watchScreen,
  publishEncodedScreen,
  type ScreenPublisher,
  type ScreenQualityId,
  type ScreenRelay,
  type ScreenSendStats,
  type ScreenWatcher,
  type ScreenWatchStatus,
} from '../screenshare'
import { previewH264, startH264Feed, systemAudioTrack, type H264Feed, type SystemAudio } from '../jlocal/h264Feed'
import { applySoundChoice } from '../jlocal/soundChoice'

/** A subscription the relay turned away (no such broadcast yet) is tried again after this long. */
const WATCH_RETRY_MS = 4_000
/**
 * One still waiting for its catalog is left alone much longer: a fresh QUIC
 * handshake plus a 4K keyframe on a busy link can take more than a few
 * seconds, and tearing that down every four was what kept tiles at
 * "connecting" for minutes.
 */
const LOADING_RETRY_MS = 15_000
/** How often the encoder is asked what it is really sending. */
const STATS_SAMPLE_MS = 1_000

export type ScreenShareState = 'idle' | 'starting' | 'sharing' | 'failed'

/** What the jlocal picker chose. */
export interface JlocalPick {
  target: { kind: 'display' | 'window'; id: string }
  quality: ScreenQualityId
  audio: boolean
}

const pendingPicks = new Map<string, JlocalPick>()

/** A pick made on the home page waits here until the room knows who we are. */
export function stashJlocalPick(roomId: string, pick: JlocalPick): void {
  pendingPicks.set(roomId, pick)
}

export function takeJlocalPick(roomId: string): JlocalPick | null {
  const pick = pendingPicks.get(roomId) ?? null
  pendingPicks.delete(roomId)
  return pick
}

/** Why sharing stopped short. A picker the member dismissed is not an error. */
export type ScreenShareError = 'closed' | 'full' | 'failed'

/** As many screens as the room accepts at once; mirrors `MaxScreenShares` on the server. */
export const MAX_SCREENS = 4

/** One live screen of the room, as a stage needs it. */
export interface ScreenTile {
  memberId: string
  nickname: string
  since: string
  /** Mine — painted from {@link ScreenShareApi.preview}, not from a watcher. */
  self: boolean
  /** A remote tile's subscription state; always `live` for my own tile. */
  status: ScreenWatchStatus
  /** Frames arrived and then stopped: the canvas holds a stale picture. */
  stalled: boolean
}

export interface ScreenShareApi {
  /** Whether this browser can carry a screen either way. */
  supported: boolean
  /** Whether this member may publish right now: the host always, guests while open. */
  mayPublish: boolean
  /** The room already carries as many screens as it takes; starting another is refused. */
  full: boolean
  /** The host's switch, as the room has it. */
  shareOpen: boolean
  /** Every live screen, mine included, oldest first. */
  screens: ScreenTile[]
  /** My own publishing state. */
  state: ScreenShareState
  /** Why my last attempt stopped short; cleared by the next attempt. */
  error: ScreenShareError | null
  quality: ScreenQualityId
  /** What my encoder is really sending; null until it has been sampled. */
  stats: ScreenSendStats | null
  /** My own stream, for a muted `<video>` preview. */
  preview: MediaStream | null
  muted: boolean
  /** Opens the picker and publishes what it returns. A dismissed picker is a no-op. */
  start(quality?: ScreenQualityId): void
  /** Publishes what the jlocal companion captures: hardware H.264, no re-encode. */
  startWithJlocal(pick: JlocalPick): Promise<void>
  /** Another surface from the browser's picker, on the same broadcast. */
  switchSource(): void
  /** Another display or window from the companion, on the same broadcast. */
  switchJlocal(pick: JlocalPick): Promise<void>
  viaJlocal: boolean
  /** Where my own jlocal share paints itself; null when publishing from the browser. */
  selfCanvasRef: (canvas: HTMLCanvasElement | null) => void
  stop(): void
  /** Re-sizes a live share in place, and remembers the choice for the next one. */
  setQuality(id: ScreenQualityId): void
  setMuted(muted: boolean): void
  setShareOpen(open: boolean): Promise<void>
  /** Binds a remote member's screen to a canvas, or unbinds it when passed null. */
  attach(memberId: string, canvas: HTMLCanvasElement | null): void
  /**
   * The same thing as a ref callback, one stable function per member, so
   * `ref={canvasRef(memberId)}` does not resubscribe on every render.
   */
  canvasRef(memberId: string): (canvas: HTMLCanvasElement | null) => void
}

interface Attached {
  canvas: HTMLCanvasElement
  watcher: ScreenWatcher | null
  unsubscribe?: () => void
  /** Bumped on every resubscribe so a late promise from an older one is dropped. */
  generation: number
  closed: boolean
  /** When the current subscription was opened; a silent one is retried on its own clock. */
  openedAt: number
}

/**
 * The whole screen-sharing machine of a room: who is publishing, what I am
 * publishing, and one subscription per remote screen.
 *
 * The relay announces nothing and keeps no history, so a subscription opened
 * before its publisher is up finds no track and stays silent forever. The
 * room's list of live screens is what says a path exists, and a tile that sees
 * no frames resubscribes until it does.
 */
export function useScreenShare({ roomId, memberId, nickname, capability, isController, shareOpen, screens, onScreenStarted }: {
  roomId: string
  memberId: string
  nickname: string
  capability: string
  isController: boolean
  shareOpen: boolean
  screens: ScreenShareInfo[]
  onScreenStarted?: (share: ScreenShareInfo) => void
}): ScreenShareApi {
  const publisherRef = useRef<ScreenPublisher | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const jlocalRef = useRef<{ feed: H264Feed; audio: SystemAudio | null; preview: (() => void) | null } | null>(null)
  /** My own tile's canvas, bound whenever the tile exists, whichever path is publishing. */
  const selfCanvasElRef = useRef<HTMLCanvasElement | null>(null)
  const relayRef = useRef<ScreenRelay | null>(null)
  const attachedRef = useRef(new Map<string, Attached>())
  const mutedRef = useRef(false)
  const startedRef = useRef<Set<string> | null>(null)
  const canvasRefsRef = useRef(new Map<string, (canvas: HTMLCanvasElement | null) => void>())
  const noticeRef = useRef(onScreenStarted)
  noticeRef.current = onScreenStarted

  const [relay, setRelay] = useState<ScreenRelay | null>(null)
  const [state, setState] = useState<ScreenShareState>('idle')
  const [error, setError] = useState<ScreenShareError | null>(null)
  const [quality, setQualityState] = useState<ScreenQualityId>(() => loadScreenQuality())
  const [stats, setStats] = useState<ScreenSendStats | null>(null)
  const [preview, setPreview] = useState<MediaStream | null>(null)
  const [muted, setMutedState] = useState(false)
  /** Whether the live share is the companion's feed rather than the browser's stream. */
  const [viaJlocal, setViaJlocal] = useState(false)
  const [watchStatus, setWatchStatus] = useState<Record<string, ScreenWatchStatus>>({})
  const [seenLive, setSeenLive] = useState<Record<string, boolean>>({})

  const supported = useMemo(() => screenShareSupported(), [])
  const mayPublish = isController || shareOpen

  const stop = useCallback(() => {
    publisherRef.current?.close()
    publisherRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    const companion = jlocalRef.current
    if (companion) {
      jlocalRef.current = null
      companion.preview?.()
      companion.audio?.stop()
      companion.feed.stop()
    }
    setPreview(null)
    setStats(null)
    setViaJlocal(false)
    setState('idle')
    if (memberId && capability) void setScreenLive(roomId, memberId, capability, false).catch(() => undefined)
  }, [roomId, memberId, capability])
  const stopRef = useRef(stop)
  stopRef.current = stop

  const publish = useCallback(async (stream: MediaStream, qualityId: ScreenQualityId) => {
    setState('starting')
    setError(null)
    const current = await fetchScreenRelay(roomId, memberId, capability, true)
    if (!current.publish) throw new Error('sharing_closed')
    const publisher = await publishScreen(current, stream, qualityId)
    try {
      publisherRef.current = publisher
      streamRef.current = stream
      setPreview(stream)
      setViaJlocal(false)
      setState('sharing')
      stream.getVideoTracks()[0]?.addEventListener('ended', stop, { once: true })
      await publisher.ready
      await setScreenLive(roomId, memberId, capability, true)
    } catch (failure) {
      stop()
      throw failure
    }
  }, [roomId, memberId, capability, stop])

  const openFeed = (pick: JlocalPick) => {
    const quality = screenQuality(pick.quality)
    return startH264Feed({
      target: pick.target,
      width: quality.width ?? 1920,
      height: quality.height ?? 1080,
      fps: quality.frameRate ?? 30,
      bitrate: quality.maxBitrate,
    })
  }
  const encodedSource = (feed: H264Feed) => ({ width: feed.width, height: feed.height, frameRate: feed.fps, bitrate: feed.bitrate, open: feed.open })

  /** Publishes the companion's feed under this member; `startWithJlocal` and a reconnect both come here. */
  const publishJlocal = useCallback(async (companion: NonNullable<typeof jlocalRef.current>, qualityId: ScreenQualityId) => {
    const relay = await fetchScreenRelay(roomId, memberId, capability, true)
    if (!relay.publish) throw new Error('sharing_closed')
    const publisher = await publishEncodedScreen(relay, encodedSource(companion.feed), companion.audio?.track)
    publisherRef.current = publisher
    // A stream stands in for the browser's own so the tile knows it is mine.
    streamRef.current = new MediaStream()
    setQualityState(qualityId)
    saveScreenQuality(qualityId)
    setViaJlocal(true)
    setState('sharing')
    companion.preview?.()
    companion.preview = selfCanvasElRef.current ? previewH264(companion.feed, selfCanvasElRef.current) : null
    await publisher.ready
    await setScreenLive(roomId, memberId, capability, true)
  }, [roomId, memberId, capability])

  const startWithJlocal = useCallback(async (pick: JlocalPick) => {
    setState('starting')
    setError(null)
    // The app is told which sounds go out before the first frame leaves.
    applySoundChoice()
    const feed = await openFeed(pick)
    const audio = pick.audio ? systemAudioTrack() : null
    const companion = { feed, audio, preview: null as (() => void) | null }
    jlocalRef.current = companion
    try {
      await publishJlocal(companion, pick.quality)
    } catch (failure) {
      stop()
      throw failure
    }
  }, [publishJlocal, stop])

  /**
   * Another display or window from the companion, without leaving the relay:
   * the new feed is opened first, the publisher swapped onto it, and only then
   * the old capture ended. A share that came from the browser is restarted
   * instead, since the two publishers cannot trade places.
   */
  const switchJlocal = useCallback(async (pick: JlocalPick) => {
    const companion = jlocalRef.current
    const publisher = publisherRef.current
    if (!companion || !publisher) {
      stop()
      await startWithJlocal(pick)
      return
    }
    const feed = await openFeed(pick)
    try {
      await publisher.switchSource(encodedSource(feed))
    } catch (failure) {
      feed.stop()
      throw failure
    }
    const previous = companion.feed
    companion.feed = feed
    companion.preview?.()
    companion.preview = selfCanvasElRef.current ? previewH264(feed, selfCanvasElRef.current) : null
    if (pick.audio && !companion.audio) {
      companion.audio = systemAudioTrack()
      publisher.setAudio(companion.audio?.track)
    } else if (!pick.audio && companion.audio) {
      publisher.setAudio(undefined)
      companion.audio.stop()
      companion.audio = null
    }
    previous.stop()
    setQualityState(pick.quality)
    saveScreenQuality(pick.quality)
    setStats(null)
  }, [startWithJlocal, stop])

  const selfCanvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    if (selfCanvasElRef.current === canvas) return
    selfCanvasElRef.current = canvas
    const companion = jlocalRef.current
    if (!companion) return
    companion.preview?.()
    companion.preview = canvas && publisherRef.current ? previewH264(companion.feed, canvas) : null
  }, [])

  const fail = useCallback((failure: unknown) => {
    if (isScreenShareCancelled(failure)) { setState('idle'); return }
    setState('failed')
    const reason = failure instanceof Error ? failure.message : ''
    setError(reason === 'sharing_closed' ? 'closed' : reason === 'too_many_screens' ? 'full' : 'failed')
  }, [])

  const startJlocal = useCallback((pick: JlocalPick) => startWithJlocal(pick).catch((failure: unknown) => { fail(failure); throw failure }), [startWithJlocal, fail])

  const start = useCallback((pick?: ScreenQualityId) => {
    const qualityId = pick ?? quality
    // The picker must be opened inside the click, before any await.
    void requestScreenStream(qualityId).then(async (stream) => {
      try {
        await publish(stream, qualityId)
      } catch (failure) {
        stream.getTracks().forEach((track) => track.stop())
        throw failure
      }
    }).catch(fail)
  }, [quality, publish, fail])

  /**
   * The browser's picker again, for another surface on the same broadcast.
   * Dismissing it keeps the current share; a share that came from the
   * companion is restarted through the browser instead.
   */
  const switchSource = useCallback(() => {
    const publisher = publisherRef.current
    if (!publisher || jlocalRef.current) {
      stop()
      start()
      return
    }
    // Opened inside the click, before any await, or the browser refuses.
    void requestScreenStream(quality).then(async (stream) => {
      const current = publisherRef.current
      if (current !== publisher) { stream.getTracks().forEach((track) => track.stop()); return }
      const previous = streamRef.current
      await publisher.switchStream(stream)
      previous?.getTracks().forEach((track) => track.stop())
      streamRef.current = stream
      setPreview(stream)
      setStats(null)
      stream.getVideoTracks()[0]?.addEventListener('ended', stop, { once: true })
    }).catch((failure: unknown) => { if (!isScreenShareCancelled(failure)) fail(failure) })
  }, [quality, start, stop, fail])

  const setQuality = useCallback((id: ScreenQualityId) => {
    setQualityState(id)
    saveScreenQuality(id)
    void publisherRef.current?.setQuality(id).catch(() => undefined)
  }, [])

  const setMuted = useCallback((next: boolean) => {
    mutedRef.current = next
    setMutedState(next)
    for (const entry of attachedRef.current.values()) entry.watcher?.muted.set(next)
  }, [])

  const setOpen = useCallback((open: boolean) => setScreenShareOpen(roomId, memberId, capability, open), [roomId, memberId, capability])

  // Everyone needs the relay to watch, and its answer also says whether this
  // member may publish, so it is refetched when the host flips the switch.
  useEffect(() => {
    if (!memberId || !capability) return
    let disposed = false
    void fetchScreenRelay(roomId, memberId, capability)
      .then((current) => {
        if (disposed) return
        relayRef.current = current
        setRelay(current)
      })
      .catch(() => undefined)
    return () => { disposed = true }
  }, [roomId, memberId, capability, shareOpen])

  // A stream granted on the home page is published as soon as the room knows who we are.
  useEffect(() => {
    if (!memberId || !capability) return
    const pick = takeJlocalPick(roomId)
    if (pick) {
      if (mayPublish && supported) void startJlocal(pick).catch(() => undefined)
      return
    }
    const granted = takeScreenStream(roomId)
    if (!granted) return
    if (!mayPublish || !supported) {
      granted.getTracks().forEach((track) => track.stop())
      return
    }
    publish(granted, loadScreenQuality()).catch((failure: unknown) => {
      granted.getTracks().forEach((track) => track.stop())
      fail(failure)
    })
    // The stash is taken once, on the first render that knows the member.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, memberId, capability])

  // Leaving the room or closing the tab ends the broadcast; the room learns it
  // either way, because the live flag is sent with keepalive. Registered once:
  // a member id that changes must not count as leaving.
  useEffect(() => {
    const leave = () => { if (streamRef.current) stopRef.current() }
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      leave()
    }
  }, [])

  // A socket that reconnects comes back as a new member, and the room has
  // already dropped the old one's screen. The surface the member picked is
  // kept and published again under the new name.
  const identityRef = useRef(memberId)
  useEffect(() => {
    const previous = identityRef.current
    identityRef.current = memberId
    const stream = streamRef.current
    if (!memberId || previous === memberId || !stream) return
    publisherRef.current?.close()
    publisherRef.current = null
    const companion = jlocalRef.current
    if (companion) {
      publishJlocal(companion, loadScreenQuality()).catch((failure: unknown) => {
        stopRef.current()
        fail(failure)
      })
      return
    }
    publish(stream, loadScreenQuality()).catch((failure: unknown) => {
      stream.getTracks().forEach((track) => track.stop())
      fail(failure)
    })
  }, [memberId, publish, publishJlocal, fail])

  // A host closing the room to guests takes the guests' screens down with it.
  useEffect(() => {
    if (shareOpen || isController || !streamRef.current) return
    stop()
    setError('closed')
  }, [shareOpen, isController, stop])

  useEffect(() => {
    if (state !== 'sharing') return
    const timer = setInterval(() => {
      const sample = publisherRef.current?.sample()
      if (sample) setStats(sample)
    }, STATS_SAMPLE_MS)
    return () => clearInterval(timer)
  }, [state])

  const open = useCallback((entry: Attached, target: string) => {
    const current = relayRef.current
    if (!current) return
    const generation = entry.generation
    void watchScreen(current, screenPath(current.base, target), entry.canvas, mutedRef.current)
      .then((watcher) => {
        if (entry.closed || entry.generation !== generation) { watcher.close(); return }
        entry.watcher = watcher
        const apply = (status: ScreenWatchStatus) => {
          setWatchStatus((all) => (all[target] === status ? all : { ...all, [target]: status }))
          if (status === 'live') setSeenLive((all) => (all[target] ? all : { ...all, [target]: true }))
        }
        apply(watcher.status.peek())
        entry.unsubscribe = watcher.status.subscribe(apply)
      })
      .catch(() => undefined)
  }, [])

  const close = useCallback((entry: Attached) => {
    entry.closed = true
    entry.unsubscribe?.()
    entry.watcher?.close()
    entry.watcher = null
    entry.unsubscribe = undefined
  }, [])

  const attach = useCallback((target: string, canvas: HTMLCanvasElement | null) => {
    const attached = attachedRef.current
    const existing = attached.get(target)
    if (!canvas) {
      if (existing) { close(existing); attached.delete(target) }
      return
    }
    if (existing && existing.canvas === canvas) return
    if (existing) { close(existing); attached.delete(target) }
    const entry: Attached = { canvas, watcher: null, generation: 0, closed: false, openedAt: performance.now() }
    attached.set(target, entry)
    open(entry, target)
  }, [open, close])

  const canvasRef = useCallback((target: string) => {
    const cached = canvasRefsRef.current.get(target)
    if (cached) return cached
    const callback = (canvas: HTMLCanvasElement | null) => attach(target, canvas)
    canvasRefsRef.current.set(target, callback)
    return callback
  }, [attach])

  // A tile can be bound before the relay answers; it gets its subscription the
  // moment it does, instead of waiting out a retry.
  useEffect(() => {
    if (!relay) return
    for (const [target, entry] of attachedRef.current) {
      if (entry.watcher) continue
      entry.generation += 1
      entry.openedAt = performance.now()
      open(entry, target)
    }
  }, [relay, open])

  // A broadcast that never spoke is subscribed to again — there is nothing else
  // to wait for, since the relay announces nothing. Each tile keeps its own
  // clock, so a status that flickers does not push the retry away forever.
  const watchStatusRef = useRef(watchStatus)
  watchStatusRef.current = watchStatus
  useEffect(() => {
    const timer = setInterval(() => {
      const now = performance.now()
      for (const [target, entry] of attachedRef.current) {
        const status = entry.watcher ? watchStatusRef.current[target] ?? 'offline' : 'offline'
        if (status === 'live') continue
        if (now - entry.openedAt < (status === 'loading' ? LOADING_RETRY_MS : WATCH_RETRY_MS)) continue
        close(entry)
        entry.closed = false
        entry.generation += 1
        entry.openedAt = now
        open(entry, target)
      }
    }, WATCH_RETRY_MS / 4)
    return () => clearInterval(timer)
  }, [open, close])

  useEffect(() => () => {
    for (const entry of attachedRef.current.values()) close(entry)
    attachedRef.current.clear()
  }, [close])

  const sharing = state === 'sharing' || state === 'starting'
  const full = !sharing && screens.filter((screen) => screen.memberId !== memberId).length >= MAX_SCREENS

  const tiles = useMemo<ScreenTile[]>(() => {
    const listed = screens.filter((screen) => screen.memberId !== memberId)
    const mine = screens.find((screen) => screen.memberId === memberId)
    const all: ScreenShareInfo[] = sharing
      ? [...listed, mine ?? { memberId, nickname, since: new Date().toISOString() }]
      : listed
    return all
      .sort((left, right) => left.since.localeCompare(right.since))
      .map((screen) => {
        const self = screen.memberId === memberId
        const status = self ? 'live' : watchStatus[screen.memberId] ?? 'offline'
        return {
          ...screen,
          self,
          status,
          stalled: !self && status !== 'live' && seenLive[screen.memberId] === true,
        }
      })
  }, [screens, memberId, nickname, sharing, watchStatus, seenLive])

  // Screens the room gained since the last render are news; the first list is
  // the room as we found it.
  useEffect(() => {
    const ids = new Set(screens.map((screen) => screen.memberId))
    const known = startedRef.current
    startedRef.current = ids
    if (!known) return
    for (const screen of screens) {
      if (known.has(screen.memberId) || screen.memberId === memberId) continue
      noticeRef.current?.(screen)
    }
  }, [screens, memberId])

  return {
    supported,
    mayPublish,
    full,
    shareOpen,
    screens: tiles,
    state,
    error,
    quality,
    stats,
    preview,
    muted,
    start,
    startWithJlocal: startJlocal,
    switchSource,
    switchJlocal,
    viaJlocal,
    selfCanvasRef,
    stop,
    setQuality,
    setMuted,
    setShareOpen: setOpen,
    attach,
    canvasRef,
  }
}
