import { ensureHuman, forgetHuman, humanReady } from '../human'
import { GATE_READY_BUFFER_MS } from './gate'
import { playbackHealth } from './playbackHealth'
import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from 'react'
import type { ChatMessage, MediaSnapshot, Member, MemberReadiness, PlayState, PresenceEvent, RoomWaiting, Spotlight, StageKind, TitleRequest } from '../types'
import { initialStages, stagesReducer, type StagesState } from '../room/stages'
import { loadPickedAvatar } from '../room/avatar'
import { deviceId, joinTicketFor } from '../join'
import { expectedPositionMs, needsResync } from './position'
import { ownerTokenFor } from '../upload'
import { isDesktop } from '../platform'
import { browserMediaIdle, needBrowserMedia } from '../desktop/localRoom'

const PRESENCE_LIMIT = 50
const WAITING_REPORT_MS = 1000
const READINESS_DEBOUNCE_MS = 100
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 8000
/**
 * The server answers every heartbeat, so a socket that has said nothing for
 * this long is dead whatever its readyState claims — the browser only learns
 * of a lost link when a write fails, and a viewer sends almost nothing.
 */
const HEARTBEAT_MS = 5000
const DEAD_AFTER_MS = 15_000

interface Outbound {
  type: string
  memberId?: string
  state?: PlayState
  controllerId?: string
  members?: Member[]
  message?: ChatMessage
  history?: ChatMessage[]
  status?: string
  serverTimeMs?: number
  clientTimeMs?: number
  error?: string
  capability?: string
  readiness?: MemberReadiness[]
  targetMs?: number
  deadlineMs?: number
  gating?: boolean
  hostSubtitles?: HostSubtitles
  media?: MediaSnapshot
  requestId?: string
  kind?: StageKind
  nickname?: string
  allow?: boolean
  spotlight?: Spotlight
  mic?: boolean
  cam?: boolean
  title?: {
    metaId: string
    metaType: 'movie' | 'series'
    name: string
    poster?: string
    season?: number
    episode?: number
    from?: string
  }
}

/** The controller's subtitle pick: a room track index (-1 for none) and the
 * shift it watches with, for viewers who choose to copy it. */
export interface HostSubtitles {
  track: number
  delayMs: number
}

interface SyncResult {
  state: PlayState
  controllerId: string
  members: Member[]
  memberId: string
  isController: boolean
  messages: ChatMessage[]
  presence: PresenceEvent[]
  roomStatus: string
  roomVersion: number
  mediaPatch: MediaSnapshot | null
  refreshRoom: () => void
  connected: boolean
  buffering: boolean
  autoplayBlocked: boolean
  serverOffsetMs: number
  capability: string
  waiting: RoomWaiting | null
  gatingEnabled: boolean
  hostSubtitles: HostSubtitles | null
  titleRequests: TitleRequest[]
  lastError: string
  errorSeq: number
  stillThereDeadlineMs: number | null
  left: boolean
  kicked: boolean
  /** Another tab of this browser took the seat. */
  replaced: boolean
  leave: () => void
  /** Lets the seat go now, for a tab on its way out. */
  sayGoodbye: () => void
  send: (type: string, payload?: Record<string, unknown>) => boolean
  reportBuffering: (stalled: boolean) => void
  /** Requests, grants and the spotlight around the room's stages (see room/stages). */
  stages: StagesState
  /** A guest asks the host to open a stage of this kind. */
  requestStage: (kind: StageKind) => boolean
  /** The host answers a request from its inbox. */
  answerStage: (requestId: string, allow: boolean) => boolean
  /** The host or the owner takes a stage down; a screen is named by its owner. */
  closeStage: (kind: StageKind, targetId?: string) => boolean
  /** The host puts a stage or a member in front of everyone; null takes it down. */
  setSpotlight: (spotlight: Spotlight | null) => boolean
  /** Opening the stage spent the grant. */
  stageUsed: (kind: StageKind) => void
  /** Where this browser stands at the room's door: in, asked for the password, waiting for the host, turned away. */
  door: Door
  /** Try the door again, after a password got its ticket. */
  retryDoor: () => void
  /** Host: who is waiting in the lobby of an approval room. */
  knocks: { requestId: string; nickname: string }[]
  admit: (requestId: string) => boolean
  deny: (requestId: string) => boolean
  /** What the host just turned off for this member; the seq changes on each. */
  forced: { mic?: boolean; cam?: boolean; seq: number } | null
}

export type Door = 'in' | 'password' | 'badPassword' | 'lobby' | 'denied'

const TITLE_REQUEST_LIMIT = 20

const initialState: PlayState = { playing: false, positionMs: 0, rate: 1, serverTimeMs: 0 }

export function useSync(
  roomId: string,
  nickname: string,
  videoRef: RefObject<HTMLVideoElement | null>,
  mediaOffsetMsRef?: RefObject<number>,
  coldWaitRef?: RefObject<boolean>,
  remoteSteerAtRef?: RefObject<number>,
  coldForRef?: RefObject<((ms: number) => boolean) | null>,
): SyncResult {
  const socketRef = useRef<WebSocket | null>(null)
  const offsetRef = useRef(0)
  /** The seat this browser holds in the room; a reconnect asks for it back so nobody sees us leave. */
  const seatRef = useRef<{ roomId: string; memberId: string; capability: string } | null>(null)
  /** Chat typed while the socket was down; it goes out the moment the seat is ours again. */
  const pendingChatRef = useRef<Record<string, unknown>[]>([])
  const lastHeardRef = useRef(0)
  const bufferingRef = useRef(false)
  const mediaOffset = () => mediaOffsetMsRef?.current ?? 0
  const coldWait = () => coldWaitRef?.current ?? false
  const coldAt = (state: PlayState): boolean => {
    const judge = coldForRef?.current
    return judge ? judge(expectedPositionMs(state, Date.now() + offsetRef.current)) : coldWait()
  }
  const [state, setState] = useState(initialState)
  const [controllerId, setControllerId] = useState('')
  const [memberId, setMemberId] = useState('')
  const [members, setMembers] = useState<Member[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [presence, setPresence] = useState<PresenceEvent[]>([])
  const knownMembersRef = useRef<Map<string, string> | null>(null)
  const presenceSeqRef = useRef(0)
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [roomStatus, setRoomStatus] = useState('connecting')
  const [roomVersion, setRoomVersion] = useState(0)
  const [mediaPatch, setMediaPatch] = useState<MediaSnapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [serverOffsetMs, setServerOffsetMs] = useState(0)
  const [capability, setCapability] = useState('')
  const [waiting, setWaiting] = useState<RoomWaiting | null>(null)
  const [gatingEnabled, setGatingEnabled] = useState(true)
  const [hostSubtitles, setHostSubtitles] = useState<HostSubtitles | null>(null)
  const [titleRequests, setTitleRequests] = useState<TitleRequest[]>([])
  const [lastError, setLastError] = useState('')
  const [errorSeq, setErrorSeq] = useState(0)
  const [stillThereDeadlineMs, setStillThereDeadlineMs] = useState<number | null>(null)
  const [left, setLeft] = useState(false)
  const [kicked, setKicked] = useState(false)
  const [replaced, setReplaced] = useState(false)
  const titleSeqRef = useRef(0)
  const [stages, dispatchStage] = useReducer(stagesReducer, initialStages)
  const [door, setDoor] = useState<Door>('in')
  const [doorNonce, setDoorNonce] = useState(0)
  const [knocks, setKnocks] = useState<{ requestId: string; nickname: string }[]>([])
  const [forced, setForced] = useState<{ mic?: boolean; cam?: boolean; seq: number } | null>(null)

  const send = useCallback((type: string, payload: Record<string, unknown> = {}): boolean => {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) {
      // A message is worth keeping across a reconnect; a state report is not.
      if (type !== 'chat') return false
      pendingChatRef.current.push(payload)
      return true
    }
    socket.send(JSON.stringify({ type, ...payload }))
    return true
  }, [])

  const sendReadiness = useCallback(() => {
    const media = videoRef.current
    if (!media) return
    const positionMs = Math.round(media.currentTime * 1000) + mediaOffset()
    let bufferAheadMs = 0
    for (let index = 0; index < media.buffered.length; index += 1) {
      if (media.buffered.start(index) > media.currentTime + 0.1 || media.currentTime > media.buffered.end(index)) continue
      bufferAheadMs = Math.round((media.buffered.end(index) - media.currentTime) * 1000)
      if (Number.isFinite(media.duration) && media.buffered.end(index) >= media.duration - 0.3) {
        bufferAheadMs = Math.max(bufferAheadMs, GATE_READY_BUFFER_MS)
      }
      break
    }
    // A stall the buffer has since outgrown is over, whether or not the
    // element fired a playing event to say so: a stopped element never does.
    if (bufferingRef.current && bufferAheadMs >= GATE_READY_BUFFER_MS) {
      bufferingRef.current = false
      setBuffering(false)
    }
    const quality = typeof media.getVideoPlaybackQuality === 'function' ? media.getVideoPlaybackQuality() : null
    send('ready', {
      positionMs,
      bufferAheadMs,
      stalled: bufferingRef.current,
      ...playbackHealth(),
      ...(quality ? { droppedFrames: quality.droppedVideoFrames, decodedFrames: quality.totalVideoFrames } : {}),
    })
  }, [send, videoRef])

  const reportBuffering = useCallback((stalled: boolean) => {
    if (bufferingRef.current === stalled) return
    bufferingRef.current = stalled
    setBuffering(stalled)
    if (stalled) return
    const media = videoRef.current
    if (!media || media.paused) return
    setState((current) => {
      const expected = expectedPositionMs(current, Date.now() + offsetRef.current)
      if (!coldWait() && needsResync(media.currentTime * 1000 + mediaOffset(), expected)) media.currentTime = (expected - mediaOffset()) / 1000
      return current
    })
  }, [videoRef])

  /** A tab that is going says so: its seat is let go of in seconds instead of held. */
  const sayGoodbye = useCallback(() => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'leave' }))
  }, [])
  // Leaving the room's page is leaving the room. The socket's own effect
  // also reruns for a new nickname, and that keeps the seat.
  useEffect(() => sayGoodbye, [roomId, sayGoodbye])

  useEffect(() => {
    let disposed = false
    let attempt = 0
    let retry: number | null = null
    // A password room said no: the door stays shut until a ticket is in hand.
    let halted = false

    // The socket only opens for a browser that passed the bot check lately.
    const connect = () => {
      if (disposed) return
      if (humanReady()) open()
      else void ensureHuman().catch(() => undefined).finally(open)
    }

    const open = () => {
      if (disposed) return
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(`${scheme}//${window.location.host}/ws/rooms/${encodeURIComponent(roomId)}`)
      socketRef.current = socket
      knownMembersRef.current = null

      const applyMembers = (next: Member[]) => {
        const previous = knownMembersRef.current
        const roster = new Map(next.map((member) => [member.id, member.nickname]))
        if (previous) {
          const at = new Date(Date.now() + offsetRef.current).toISOString()
          const events: PresenceEvent[] = []
          for (const [id, nickname] of roster) {
            if (!previous.has(id)) events.push({ id: (presenceSeqRef.current += 1), memberId: id, nickname, kind: 'join', at })
          }
          for (const [id, nickname] of previous) {
            if (!roster.has(id)) events.push({ id: (presenceSeqRef.current += 1), memberId: id, nickname, kind: 'leave', at })
          }
          if (events.length > 0) setPresence((current) => [...current, ...events].slice(-PRESENCE_LIMIT))
        }
        knownMembersRef.current = roster
        setMembers(next)
        dispatchStage({ type: 'members', ids: next.map((member) => member.id) })
      }

      const start = async (media: HTMLVideoElement) => {
        try {
          await media.play()
          setAutoplayBlocked(false)
          return
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'NotAllowedError') return
        }
        media.muted = true
        try {
          await media.play()
          setAutoplayBlocked(false)
        } catch {
          setAutoplayBlocked(true)
        }
      }

      const applyState = (nextState: PlayState) => {
        setState(nextState)
        const media = videoRef.current
        if (!media) return
        if (remoteSteerAtRef) remoteSteerAtRef.current = Date.now()
        if (coldAt(nextState)) {
          if (!media.paused) media.pause()
          return
        }
        const expected = expectedPositionMs(nextState, Date.now() + offsetRef.current)
        if (!bufferingRef.current && needsResync(media.currentTime * 1000 + mediaOffset(), expected)) media.currentTime = (expected - mediaOffset()) / 1000
        media.playbackRate = nextState.rate || 1
        if (nextState.playing && media.paused) void start(media)
        if (!nextState.playing && !media.paused) {
          media.pause()
          setAutoplayBlocked(false)
        }
      }

      let opened = false
      socket.onopen = () => {
        opened = true
        attempt = 0
        lastHeardRef.current = Date.now()
        setConnected(true)
        const clientTimeMs = Date.now()
        const seat = seatRef.current?.roomId === roomId ? seatRef.current : null
        const picked = loadPickedAvatar()
        socket.send(JSON.stringify({
          type: 'hello',
          nickname,
          clientTimeMs,
          ownerToken: ownerTokenFor(roomId),
          ...(joinTicketFor(roomId) ? { ticket: joinTicketFor(roomId) } : {}),
          ...(seat ? { memberId: seat.memberId, capability: seat.capability } : {}),
          ...(deviceId() ? { device: deviceId() } : {}),
          ...(picked ? { avatar: picked } : {}),
          ...(isDesktop() ? { client: 'desktop', features: ['localSource'] } : {}),
        }))
      }
      socket.onclose = () => {
        setConnected(false)
        // Refused at the upgrade: most likely the day's check ran out.
        if (!opened) forgetHuman()
        if (disposed || halted || socketRef.current !== socket) return
        const backoff = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS)
        attempt += 1
        retry = window.setTimeout(connect, backoff * (0.75 + Math.random() * 0.5))
      }
      socket.onmessage = (event) => {
        // A socket this tab already moved on from: its last words are not ours.
        if (socketRef.current !== socket) return
        lastHeardRef.current = Date.now()
        const message = JSON.parse(String(event.data)) as Outbound
        if (message.serverTimeMs !== undefined && message.clientTimeMs !== undefined) {
          const now = Date.now()
          const offset = message.serverTimeMs - (message.clientTimeMs + (now - message.clientTimeMs) / 2)
          offsetRef.current = offset
          setServerOffsetMs(offset)
        }
        switch (message.type) {
          case 'lobby':
            setDoor('lobby')
            break
          case 'admitted':
            setDoor('in')
            break
          case 'denied':
            halted = true
            setDoor('denied')
            break
          case 'knock':
            if (message.requestId) {
              const knock = { requestId: message.requestId, nickname: message.nickname ?? '' }
              setKnocks((current) => current.some((item) => item.requestId === knock.requestId) ? current : [...current, knock])
            }
            break
          case 'forceMedia':
            setForced((current) => ({
              ...(message.mic !== undefined ? { mic: message.mic } : {}),
              ...(message.cam !== undefined ? { cam: message.cam } : {}),
              seq: (current?.seq ?? 0) + 1,
            }))
            break
          case 'welcome':
            setDoor('in')
            seatRef.current = { roomId, memberId: message.memberId ?? '', capability: message.capability ?? '' }
            for (const payload of pendingChatRef.current.splice(0)) socket.send(JSON.stringify({ type: 'chat', ...payload }))
            setMemberId(message.memberId ?? '')
            setControllerId(message.controllerId ?? '')
            applyMembers(message.members ?? [])
            setMessages(message.history ?? [])
            setCapability(message.capability ?? '')
            setGatingEnabled(message.gating ?? true)
            setHostSubtitles(message.hostSubtitles ?? null)
            setWaiting(null)
            setRoomStatus('live')
            setRoomVersion((version) => version + 1)
            if (message.state) applyState(message.state)
            break
          case 'state':
            setWaiting(null)
            if (message.state) applyState(message.state)
            break
          case 'waiting':
            setWaiting({ targetMs: message.targetMs ?? 0, readiness: message.readiness ?? [] })
            break
          case 'error':
            if (message.error === 'password_required' || message.error === 'bad_ticket') {
              halted = true
              setDoor(message.error === 'bad_ticket' ? 'badPassword' : 'password')
            }
            setLastError(message.error ?? 'error')
            setErrorSeq((seq) => seq + 1)
            if (message.error === 'kicked' || message.error === 'replaced') {
              halted = true
              if (message.error === 'kicked') setKicked(true)
              else setReplaced(true)
              setLeft(true)
              setConnected(false)
            }
            break
          case 'stillThere':
            setStillThereDeadlineMs(message.deadlineMs ?? null)
            break
          case 'awake':
            setStillThereDeadlineMs(null)
            break
          case 'gating':
            setGatingEnabled(message.gating ?? true)
            break
          case 'hostSubtitles':
            setHostSubtitles(message.hostSubtitles ?? null)
            break
          case 'members':
            setControllerId(message.controllerId ?? '')
            applyMembers(message.members ?? [])
            break
          case 'chat':
            if (message.message) setMessages((current) => [...current, message.message!])
            break
          case 'needBrowserMedia': {
            const held = seatRef.current
            if (held?.roomId === roomId) void needBrowserMedia(roomId, { memberId: held.memberId, capability: held.capability })
            break
          }
          case 'browserMediaIdle':
            void browserMediaIdle(roomId)
            break
          case 'roomStatus':
            setRoomStatus(message.status ?? '')
            setRoomVersion((version) => version + 1)
            break
          case 'roomUpdated':
            if (message.media) setMediaPatch(message.media)
            else setRoomVersion((version) => version + 1)
            break
          case 'stageRequest':
            if (message.requestId && message.memberId && message.kind) {
              dispatchStage({ type: 'stageRequest', requestId: message.requestId, memberId: message.memberId, nickname: message.nickname ?? '', kind: message.kind })
            }
            break
          case 'stageGrant':
            if (message.kind) dispatchStage({ type: 'stageGrant', kind: message.kind, allow: message.allow === true, at: Date.now() })
            break
          case 'stageClosed':
            if (message.kind) dispatchStage({ type: 'stageClosed', kind: message.kind })
            break
          case 'spotlight':
            dispatchStage({ type: 'spotlight', spotlight: message.spotlight ?? null })
            break
          case 'titleRequest': {
            const title = message.title
            if (!title) break
            const request: TitleRequest = {
              id: (titleSeqRef.current += 1),
              memberId: message.memberId ?? '',
              from: title.from ?? '',
              metaId: title.metaId,
              metaType: title.metaType,
              name: title.name,
              poster: title.poster ?? '',
              season: title.season,
              episode: title.episode,
              at: new Date(Date.now() + offsetRef.current).toISOString(),
            }
            setTitleRequests((current) => [...current, request].slice(-TITLE_REQUEST_LIMIT))
            break
          }
        }
      }
    }

    const wakeUp = () => {
      if (disposed || socketRef.current?.readyState === WebSocket.OPEN) return
      if (document.visibilityState === 'hidden') return
      if (retry !== null) window.clearTimeout(retry)
      attempt = 0
      connect()
    }
    window.addEventListener('online', wakeUp)
    document.addEventListener('visibilitychange', wakeUp)
    window.addEventListener('pagehide', sayGoodbye)

    const heartbeat = window.setInterval(() => {
      const socket = socketRef.current
      if (socket?.readyState === WebSocket.OPEN && Date.now() - lastHeardRef.current > DEAD_AFTER_MS) {
        // Closing it ourselves is what brings the reconnect loop in; the
        // seat is asked back straight away rather than after a backoff.
        attempt = 0
        socket.close()
        return
      }
      send('heartbeat', { clientTimeMs: Date.now() })
      sendReadiness()
      const media = videoRef.current
      if (!media || bufferingRef.current || coldWait()) return
      if (media.paused) return
      setState((current) => {
        const expected = expectedPositionMs(current, Date.now() + offsetRef.current)
        if (needsResync(media.currentTime * 1000 + mediaOffset(), expected)) media.currentTime = (expected - mediaOffset()) / 1000
        return current
      })
    }, HEARTBEAT_MS)

    if (left) return
    connect()

    return () => {
      disposed = true
      window.clearInterval(heartbeat)
      if (retry !== null) window.clearTimeout(retry)
      window.removeEventListener('online', wakeUp)
      document.removeEventListener('visibilitychange', wakeUp)
      window.removeEventListener('pagehide', sayGoodbye)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [nickname, roomId, send, sendReadiness, videoRef, left, doorNonce, sayGoodbye])
  const leave = useCallback(() => {
    sayGoodbye()
    setLeft(true)
    setStillThereDeadlineMs(null)
    setConnected(false)
  }, [sayGoodbye])

  const waitingForStart = waiting !== null
  useEffect(() => {
    if (!waitingForStart) return
    sendReadiness()
    const reporter = window.setInterval(sendReadiness, WAITING_REPORT_MS)
    let soon: number | null = null
    const reportSoon = () => {
      if (soon !== null) return
      soon = window.setTimeout(() => { soon = null; sendReadiness() }, READINESS_DEBOUNCE_MS)
    }
    const media = videoRef.current
    const events = ['progress', 'canplay', 'loadeddata', 'seeked'] as const
    for (const name of events) media?.addEventListener(name, reportSoon)
    return () => {
      window.clearInterval(reporter)
      if (soon !== null) window.clearTimeout(soon)
      for (const name of events) media?.removeEventListener(name, reportSoon)
    }
  }, [sendReadiness, waitingForStart, videoRef])
  const refreshRoom = useCallback(() => setRoomVersion((version) => version + 1), [])
  const requestStage = useCallback((kind: StageKind) => {
    if (!send('stageRequest', { kind })) return false
    dispatchStage({ type: 'asked', kind })
    return true
  }, [send])
  const answerStage = useCallback((requestId: string, allow: boolean) => {
    if (!send('stageAnswer', { requestId, allow })) return false
    dispatchStage({ type: 'answered', requestId })
    return true
  }, [send])
  const closeStage = useCallback((kind: StageKind, targetId?: string) => (
    send('stageClose', targetId ? { kind, targetId } : { kind })
  ), [send])
  const setSpotlight = useCallback((spotlight: Spotlight | null) => (
    send('spotlight', spotlight ? { kind: spotlight.kind, ...(spotlight.memberId ? { targetId: spotlight.memberId } : {}) } : {})
  ), [send])
  const stageUsed = useCallback((kind: StageKind) => dispatchStage({ type: 'used', kind }), [])
  const retryDoor = useCallback(() => {
    setDoor('in')
    setDoorNonce((nonce) => nonce + 1)
  }, [])
  const answerKnock = useCallback((type: 'admit' | 'deny', requestId: string) => {
    if (!send(type, { targetId: requestId })) return false
    setKnocks((current) => current.filter((knock) => knock.requestId !== requestId))
    return true
  }, [send])
  const admit = useCallback((requestId: string) => answerKnock('admit', requestId), [answerKnock])
  const deny = useCallback((requestId: string) => answerKnock('deny', requestId), [answerKnock])

  return {
    state,
    controllerId,
    members,
    memberId,
    isController: memberId !== '' && memberId === controllerId,
    messages,
    presence,
    roomStatus,
    roomVersion,
    mediaPatch,
    refreshRoom,
    connected,
    buffering,
    autoplayBlocked,
    serverOffsetMs,
    capability,
    waiting,
    gatingEnabled,
    hostSubtitles,
    titleRequests,
    lastError,
    errorSeq,
    stillThereDeadlineMs,
    left,
    kicked,
    replaced,
    leave,
    sayGoodbye,
    send,
    reportBuffering,
    stages,
    requestStage,
    answerStage,
    closeStage,
    setSpotlight,
    stageUsed,
    door,
    retryDoor,
    knocks,
    admit,
    deny,
    forced,
  }
}
