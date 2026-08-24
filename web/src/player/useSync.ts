import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { ChatMessage, Member, MemberReadiness, PlayState, PresenceEvent, RoomWaiting, TitleRequest } from '../types'
import { expectedPositionMs, needsResync } from './position'

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
  send: (type: string, payload?: Record<string, unknown>) => void
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
): SyncResult {
  const socketRef = useRef<WebSocket | null>(null)
  const offsetRef = useRef(0)
  const bufferingRef = useRef(false)
  const mediaOffset = () => mediaOffsetMsRef?.current ?? 0
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
  const titleSeqRef = useRef(0)

  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...payload }))
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

  useEffect(() => {
    const video = videoRef.current
    const onWaiting = () => { bufferingRef.current = true; setBuffering(true) }
    const onCanPlay = () => {
      bufferingRef.current = false
      setBuffering(false)
      // A playlist that is still growing carries no ENDLIST, so hls.js reads it
      // as live and recovers a stall by seeking to the newest segment, which
      // throws the viewer to the end of whatever has been published so far.
      // Drift is only ever corrected while not buffering, so this is the first
      // moment the room's own position can be put back.
      const media = videoRef.current
      if (!media) return
      setState((current) => {
        const expected = expectedPositionMs(current, Date.now() + offsetRef.current)
        if (needsResync(media.currentTime * 1000 + mediaOffset(), expected)) media.currentTime = (expected - mediaOffset()) / 1000
        return current
      })
    }
    video?.addEventListener('waiting', onWaiting)
    video?.addEventListener('canplay', onCanPlay)

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${scheme}//${window.location.host}/ws/rooms/${encodeURIComponent(roomId)}`)
    socketRef.current = socket
    // A reconnect re-seeds from its own welcome frame instead of announcing
    // everyone who was already watching as a fresh arrival.
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
      const expected = expectedPositionMs(nextState, Date.now() + offsetRef.current)
      if (!bufferingRef.current && needsResync(media.currentTime * 1000 + mediaOffset(), expected)) media.currentTime = (expected - mediaOffset()) / 1000
      media.playbackRate = nextState.rate || 1
      if (nextState.playing && media.paused) void media.play().catch(() => undefined)
      if (!nextState.playing && !media.paused) media.pause()
    }

    socket.onopen = () => {
      setConnected(true)
      const clientTimeMs = Date.now()
      socket.send(JSON.stringify({ type: 'hello', nickname, clientTimeMs }))
    }
    socket.onclose = () => setConnected(false)
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

    const heartbeat = window.setInterval(() => {
      const clientTimeMs = Date.now()
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat', clientTimeMs }))
      sendReadiness()
      const media = videoRef.current
      if (!media || bufferingRef.current) return
      setState((current) => {
        const expected = expectedPositionMs(current, Date.now() + offsetRef.current)
        if (needsResync(media.currentTime * 1000 + mediaOffset(), expected)) media.currentTime = (expected - mediaOffset()) / 1000
        return current
      })
    }, 5000)

    return () => {
      window.clearInterval(heartbeat)
      video?.removeEventListener('waiting', onWaiting)
      video?.removeEventListener('canplay', onCanPlay)
      socket.close()
      if (socketRef.current === socket) socketRef.current = null
    }
  }, [nickname, roomId, sendReadiness, videoRef])

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
    send,
  }
}
