import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { ChatMessage, Member, MemberReadiness, PlayState, PresenceEvent, RoomWaiting, TitleRequest } from '../types'
import { expectedPositionMs, needsResync } from './position'
import { ownerTokenFor } from '../upload'

// Presence is a rolling log: the room header shows the newest entries and the
// chat keeps them inline, so an unbounded list would only grow memory.
const PRESENCE_LIMIT = 50
// Mirrors the server's GateReadyBufferMs. Only used to round a buffer that
// runs to the very end of the media up to "enough": the last seconds of a
// video can never hold 3s of lookahead, and must not stall a gated start.
const GATE_READY_BUFFER_MS = 3000
// Readiness cadence while the room is waiting on a gated start. The 5s
// heartbeat carries the steady reports; this only exists during the wait.
const WAITING_REPORT_MS = 1000
// Reconnect backoff. A dropped socket used to be permanent: the tab went mute,
// every command was swallowed, and the room played on without the person.
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
  gating?: boolean
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
  connected: boolean
  buffering: boolean
  serverOffsetMs: number
  capability: string
  waiting: RoomWaiting | null
  gatingEnabled: boolean
  titleRequests: TitleRequest[]
  lastError: string
  errorSeq: number
  // Reports whether the frame actually left. A command written into a closed
  // socket used to vanish silently, which is exactly what "I pressed pause
  // and nothing happened" looks like from the outside.
  send: (type: string, payload?: Record<string, unknown>) => boolean
  // The player owns the media element, so it owns the buffering picture. The
  // hook used to bind waiting/canplay to whatever videoRef held at mount —
  // nothing at all while a room was still being prepared, and a discarded
  // node after a source swap.
  reportBuffering: (stalled: boolean) => void
}

// The request log is a rolling inbox, like presence: old asks age out of
// memory rather than accumulating for the room's lifetime.
const TITLE_REQUEST_LIMIT = 20

const initialState: PlayState = { playing: false, positionMs: 0, rate: 1, serverTimeMs: 0 }

export function useSync(
  roomId: string,
  nickname: string,
  videoRef: MutableRefObject<HTMLVideoElement | null>,
  // Where the current media region begins on the room's absolute timeline.
  // A ref, because the socket handlers close over it once: every positionMs
  // on the wire is absolute, every media.currentTime is region-relative, and
  // this is the only place the two meet.
  mediaOffsetMsRef?: MutableRefObject<number>,
  // Raised by the player while the room points at media no region has
  // produced yet. Steering the element then would clamp it into the old
  // region: the sync layer holds still and keeps it paused instead.
  coldWaitRef?: MutableRefObject<boolean>,
  // Stamped every time a server frame steers the element. The player checks
  // it before reporting a native pause: the DOM event a remote pause produces
  // is indistinguishable from the one a media key produces, and echoing it
  // back would have the room paused twice over.
  remoteSteerAtRef?: MutableRefObject<number>,
): SyncResult {
  const socketRef = useRef<WebSocket | null>(null)
  const offsetRef = useRef(0)
  const bufferingRef = useRef(false)
  const mediaOffset = () => mediaOffsetMsRef?.current ?? 0
  const coldWait = () => coldWaitRef?.current ?? false
  const [state, setState] = useState(initialState)
  const [controllerId, setControllerId] = useState('')
  const [memberId, setMemberId] = useState('')
  const [members, setMembers] = useState<Member[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [presence, setPresence] = useState<PresenceEvent[]>([])
  // Null until the welcome frame lands. The server only broadcasts a member
  // list to the other clients, so the roster a client is handed on arrival is
  // the baseline to diff against rather than a room full of arrivals.
  const knownMembersRef = useRef<Map<string, string> | null>(null)
  const presenceSeqRef = useRef(0)
  const [roomStatus, setRoomStatus] = useState('connecting')
  // Bumps on every roomStatus message, even repeated ones, so consumers can
  // refetch tracks without interpreting a subtitle update as media readiness.
  const [roomVersion, setRoomVersion] = useState(0)
  const [connected, setConnected] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [serverOffsetMs, setServerOffsetMs] = useState(0)
  const [capability, setCapability] = useState('')
  const [waiting, setWaiting] = useState<RoomWaiting | null>(null)
  const [gatingEnabled, setGatingEnabled] = useState(true)
  const [titleRequests, setTitleRequests] = useState<TitleRequest[]>([])
  // The last refusal the server sent, with a counter so the same code twice
  // in a row still reaches whoever is showing it.
  const [lastError, setLastError] = useState('')
  const [errorSeq, setErrorSeq] = useState(0)
  const titleSeqRef = useRef(0)

  const send = useCallback((type: string, payload: Record<string, unknown> = {}): boolean => {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify({ type, ...payload }))
    return true
  }, [])

  // Reports this client's buffering picture: position, contiguous buffer held
  // ahead of it, and whether playback is stalled. A screen-share room has no
  // media element here and simply never reports.
  const sendReadiness = useCallback(() => {
    const media = videoRef.current
    if (!media) return
    const positionMs = Math.round(media.currentTime * 1000) + mediaOffset()
    let bufferAheadMs = 0
    for (let index = 0; index < media.buffered.length; index += 1) {
      if (media.buffered.start(index) > media.currentTime + 0.1 || media.currentTime > media.buffered.end(index)) continue
      bufferAheadMs = Math.round((media.buffered.end(index) - media.currentTime) * 1000)
      // Buffer running to the very end of the media is all there will ever be.
      if (Number.isFinite(media.duration) && media.buffered.end(index) >= media.duration - 0.3) {
        bufferAheadMs = Math.max(bufferAheadMs, GATE_READY_BUFFER_MS)
      }
      break
    }
    send('ready', { positionMs, bufferAheadMs, stalled: bufferingRef.current })
  }, [send, videoRef])

  // The media element's buffering picture, handed in by whoever owns the
  // element. Binding waiting/canplay here used to mean binding them to
  // whatever videoRef held when the socket opened — nothing at all while the
  // room was still being prepared, and a discarded node after a source swap.
  // The flag then stuck at its last value forever: never stalled (so a member
  // that had genuinely run dry was counted as ready), or always stalled (so
  // the room re-gated on that member every few seconds, which is the room
  // that pauses itself in cycles).
  const reportBuffering = useCallback((stalled: boolean) => {
    if (bufferingRef.current === stalled) return
    bufferingRef.current = stalled
    setBuffering(stalled)
    if (stalled) return
    // A playlist that is still growing carries no ENDLIST, so hls.js reads it
    // as live and recovers a stall by seeking to the newest segment, which
    // throws the viewer to the end of whatever has been published so far.
    // Drift is only ever corrected while not buffering, so this is the first
    // moment the room's own position can be put back.
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
      // Every handshake mints a new member id, so a reconnect re-seeds from its
      // own welcome frame instead of announcing everyone who was already
      // watching as a fresh arrival — or the viewer's own self as a departure.
      knownMembersRef.current = null

      // Diffs the roster against the last one seen and logs who came and went.
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

      const applyState = (nextState: PlayState) => {
        setState(nextState)
        const media = videoRef.current
        if (!media) return
        if (remoteSteerAtRef) remoteSteerAtRef.current = Date.now()
        if (coldWait()) {
          // The wrong region is all the element has; playing it would show the
          // wrong minutes under the room's clock. The player reloads it onto
          // the right region when that region publishes.
          if (!media.paused) media.pause()
          return
        }
        const expected = expectedPositionMs(nextState, Date.now() + offsetRef.current)
        if (!bufferingRef.current && needsResync(media.currentTime * 1000 + mediaOffset(), expected)) media.currentTime = (expected - mediaOffset()) / 1000
        media.playbackRate = nextState.rate || 1
        if (nextState.playing && media.paused) void media.play().catch(() => undefined)
        if (!nextState.playing && !media.paused) media.pause()
      }

      socket.onopen = () => {
        attempt = 0
        setConnected(true)
        const clientTimeMs = Date.now()
        // The owner token is how a reloaded host takes the controls back. A
        // guest simply has none and joins as a guest.
        socket.send(JSON.stringify({ type: 'hello', nickname, clientTimeMs, ownerToken: ownerTokenFor(roomId) }))
      }
      socket.onclose = () => {
        setConnected(false)
        if (disposed || socketRef.current !== socket) return
        // Nothing is replayed on the way back: the welcome frame re-seeds state,
        // roster and roomVersion, and a pause from forty seconds ago would only
        // re-introduce the desync this exists to prevent.
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
            // A reconnecting client may have missed roomStatus/roomUpdated
            // broadcasts entirely; refetching on every welcome closes that gap.
            setRoomVersion((version) => version + 1)
            if (message.state) applyState(message.state)
            break
          case 'state':
            // Any state broadcast supersedes a pending gated start: either the
            // gate released into it or the controller withdrew the start.
            setWaiting(null)
            if (message.state) applyState(message.state)
            break
          case 'waiting':
            setWaiting({ targetMs: message.targetMs ?? 0, readiness: message.readiness ?? [] })
            break
          case 'error':
            // Until now the server refused a command in silence, which on screen
            // is indistinguishable from the app being broken.
            setLastError(message.error ?? 'error')
            setErrorSeq((seq) => seq + 1)
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
            setRoomVersion((version) => version + 1)
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

    // A laptop that slept wakes with a socket the browser already gave up on,
    // and the close event may never arrive. Both of these are the moment the
    // person is looking at the room again.
    const wakeUp = () => {
      if (disposed || socketRef.current?.readyState === WebSocket.OPEN) return
      if (document.visibilityState === 'hidden') return
      if (retry !== null) window.clearTimeout(retry)
      attempt = 0
      connect()
    }
    window.addEventListener('online', wakeUp)
    document.addEventListener('visibilitychange', wakeUp)

    // The heartbeat reads socketRef rather than closing over one socket: it
    // outlives every reconnect.
    const heartbeat = window.setInterval(() => {
      send('heartbeat', { clientTimeMs: Date.now() })
      sendReadiness()
      const media = videoRef.current
      if (!media || bufferingRef.current || coldWait()) return
      // A stopped element does not drift. Dragging its clock every 5s only
      // repaints a frozen frame — and while disconnected it would walk the
      // viewer away from the room against a truth that is no longer arriving.
      if (media.paused) return
      setState((current) => {
        const expected = expectedPositionMs(current, Date.now() + offsetRef.current)
        if (needsResync(media.currentTime * 1000 + mediaOffset(), expected)) media.currentTime = (expected - mediaOffset()) / 1000
        return current
      })
    }, 5000)

    connect()

    return () => {
      // Disposed first: closing on purpose fires onclose, and reconnecting
      // out of a room the viewer just left is its own bug.
      disposed = true
      window.clearInterval(heartbeat)
      if (retry !== null) window.clearTimeout(retry)
      window.removeEventListener('online', wakeUp)
      document.removeEventListener('visibilitychange', wakeUp)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [nickname, roomId, send, sendReadiness, videoRef])

  // The waiting window is exactly when readiness matters, so reports tighten
  // to ~1s for its duration — and only for its duration.
  const waitingForStart = waiting !== null
  useEffect(() => {
    if (!waitingForStart) return
    sendReadiness()
    const reporter = window.setInterval(sendReadiness, WAITING_REPORT_MS)
    return () => window.clearInterval(reporter)
  }, [sendReadiness, waitingForStart])

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
    connected,
    buffering,
    serverOffsetMs,
    capability,
    waiting,
    gatingEnabled,
    titleRequests,
    lastError,
    errorSeq,
    send,
    reportBuffering,
  }
}
