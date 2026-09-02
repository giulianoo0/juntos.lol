import { GATE_READY_BUFFER_MS } from './gate'
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { ChatMessage, MediaSnapshot, Member, MemberReadiness, PlayState, PresenceEvent, RoomWaiting, TitleRequest } from '../types'
import { expectedPositionMs, needsResync } from './position'
import { ownerTokenFor } from '../upload'

const PRESENCE_LIMIT = 50
const WAITING_REPORT_MS = 1000
const READINESS_DEBOUNCE_MS = 100
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 8000

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
  media?: MediaSnapshot
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
  titleRequests: TitleRequest[]
  lastError: string
  errorSeq: number
  stillThereDeadlineMs: number | null
  left: boolean
  kicked: boolean
  leave: () => void
  send: (type: string, payload?: Record<string, unknown>) => boolean
  reportBuffering: (stalled: boolean) => void
}

const TITLE_REQUEST_LIMIT = 20

const initialState: PlayState = { playing: false, positionMs: 0, rate: 1, serverTimeMs: 0 }

export function useSync(
  roomId: string,
  nickname: string,
  videoRef: MutableRefObject<HTMLVideoElement | null>,
  mediaOffsetMsRef?: MutableRefObject<number>,
  coldWaitRef?: MutableRefObject<boolean>,
  remoteSteerAtRef?: MutableRefObject<number>,
  coldForRef?: MutableRefObject<((ms: number) => boolean) | null>,
): SyncResult {
  const socketRef = useRef<WebSocket | null>(null)
  const offsetRef = useRef(0)
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
  const [titleRequests, setTitleRequests] = useState<TitleRequest[]>([])
  const [lastError, setLastError] = useState('')
  const [errorSeq, setErrorSeq] = useState(0)
  const [stillThereDeadlineMs, setStillThereDeadlineMs] = useState<number | null>(null)
  const [left, setLeft] = useState(false)
  const [kicked, setKicked] = useState(false)
  const titleSeqRef = useRef(0)

  const send = useCallback((type: string, payload: Record<string, unknown> = {}): boolean => {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return false
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
    send('ready', { positionMs, bufferAheadMs, stalled: bufferingRef.current })
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

  useEffect(() => {
    let disposed = false
    let attempt = 0
    let retry: number | null = null

    const connect = () => {
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

      socket.onopen = () => {
        attempt = 0
        setConnected(true)
        const clientTimeMs = Date.now()
        socket.send(JSON.stringify({ type: 'hello', nickname, clientTimeMs, ownerToken: ownerTokenFor(roomId) }))
      }
      socket.onclose = () => {
        setConnected(false)
        if (disposed || socketRef.current !== socket) return
        const backoff = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS)
        attempt += 1
        retry = window.setTimeout(connect, backoff * (0.75 + Math.random() * 0.5))
      }
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Outbound
        if (message.serverTimeMs !== undefined && message.clientTimeMs !== undefined) {
          const now = Date.now()
          const offset = message.serverTimeMs - (message.clientTimeMs + (now - message.clientTimeMs) / 2)
          offsetRef.current = offset
          setServerOffsetMs(offset)
        }
        switch (message.type) {
          case 'welcome':
            setMemberId(message.memberId ?? '')
            setControllerId(message.controllerId ?? '')
            applyMembers(message.members ?? [])
            setMessages(message.history ?? [])
            setCapability(message.capability ?? '')
            setGatingEnabled(message.gating ?? true)
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
            setLastError(message.error ?? 'error')
            setErrorSeq((seq) => seq + 1)
            if (message.error === 'kicked') {
              setKicked(true)
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
          case 'members':
            setControllerId(message.controllerId ?? '')
            applyMembers(message.members ?? [])
            break
          case 'chat':
            if (message.message) setMessages((current) => [...current, message.message!])
            break
          case 'roomStatus':
            setRoomStatus(message.status ?? '')
            setRoomVersion((version) => version + 1)
            break
          case 'roomUpdated':
            if (message.media) setMediaPatch(message.media)
            else setRoomVersion((version) => version + 1)
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

    const heartbeat = window.setInterval(() => {
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
    }, 5000)

    if (left) return
    connect()

    return () => {
      disposed = true
      window.clearInterval(heartbeat)
      if (retry !== null) window.clearTimeout(retry)
      window.removeEventListener('online', wakeUp)
      document.removeEventListener('visibilitychange', wakeUp)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [nickname, roomId, send, sendReadiness, videoRef, left])
  const leave = useCallback(() => {
    setLeft(true)
    setStillThereDeadlineMs(null)
    setConnected(false)
  }, [])

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
    titleRequests,
    lastError,
    errorSeq,
    stillThereDeadlineMs,
    left,
    kicked,
    leave,
    send,
    reportBuffering,
  }
}
