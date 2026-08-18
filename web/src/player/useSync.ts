import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { ChatMessage, Member, PlayState, PresenceEvent } from '../types'
import { expectedPositionMs, needsResync } from './position'

// Presence is a rolling log: the room header shows the newest entries and the
// chat keeps them inline, so an unbounded list would only grow memory.
const PRESENCE_LIMIT = 50

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
  send: (type: string, payload?: Record<string, unknown>) => void
}

const initialState: PlayState = { playing: false, positionMs: 0, rate: 1, serverTimeMs: 0 }

export function useSync(
  roomId: string,
  nickname: string,
  videoRef: MutableRefObject<HTMLVideoElement | null>,
): SyncResult {
  const socketRef = useRef<WebSocket | null>(null)
  const offsetRef = useRef(0)
  const bufferingRef = useRef(false)
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

  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...payload }))
  }, [])

  useEffect(() => {
    const video = videoRef.current
    const onWaiting = () => { bufferingRef.current = true; setBuffering(true) }
    const onCanPlay = () => { bufferingRef.current = false; setBuffering(false) }
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
      if (!bufferingRef.current && needsResync(media.currentTime * 1000, expected)) media.currentTime = expected / 1000
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
          setRoomStatus('live')
          if (message.state) applyState(message.state)
          break
        case 'state':
          if (message.state) applyState(message.state)
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
      }
    }

    const heartbeat = window.setInterval(() => {
      const clientTimeMs = Date.now()
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat', clientTimeMs }))
      const media = videoRef.current
      if (!media || bufferingRef.current) return
      setState((current) => {
        const expected = expectedPositionMs(current, Date.now() + offsetRef.current)
        if (needsResync(media.currentTime * 1000, expected)) media.currentTime = expected / 1000
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
  }, [nickname, roomId, videoRef])

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
    send,
  }
}
