// A bare room for e2e-call.mjs: joins over the real socket, runs useCall, and draws one
// box per member with their CallVideo and the call's state as data attributes. No room UI:
// the real page mounts the same hook once the room is integrated.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CallProvider, CallVideo } from '../src/call/CallVideo'
import { useCall, type CallMessage } from '../src/call/useCall'
import type { Member } from '../src/types'

const query = new URLSearchParams(location.search)
const roomId = query.get('room')!
const nickname = query.get('nickname') ?? 'e2e'
const ownerToken = query.get('owner') ?? undefined

interface Seat { memberId: string; capability: string; controllerId: string; members: Member[] }

function useRoomSocket() {
  const [seat, setSeat] = useState<Seat | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const listenerRef = useRef<(message: { type: string; mic?: boolean; cam?: boolean }) => void>(() => undefined)
  useEffect(() => {
    const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/rooms/${roomId}`)
    socketRef.current = socket
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', nickname, ownerToken, clientTimeMs: Date.now() }))
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data as string)
      if (message.type === 'welcome') {
        setSeat({ memberId: message.memberId, capability: message.capability, controllerId: message.controllerId, members: message.members ?? [] })
      } else if (message.type === 'members') {
        setSeat((current) => current && { ...current, controllerId: message.controllerId ?? current.controllerId, members: message.members ?? [] })
      }
      listenerRef.current(message)
    }
    const heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat', clientTimeMs: Date.now() }))
    }, 5_000)
    return () => { clearInterval(heartbeat); socket.close() }
  }, [])
  const send = useMemo(() => (message: CallMessage) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message))
  }, [])
  return { seat, send, listenerRef }
}

function Room({ seat, send, listenerRef }: { seat: Seat; send: (message: CallMessage) => void; listenerRef: ReturnType<typeof useRoomSocket>['listenerRef'] }) {
  const call = useCall({ roomId, memberId: seat.memberId, capability: seat.capability, send, members: seat.members })
  listenerRef.current = call.receive
  const host = seat.controllerId === seat.memberId
  ;(window as unknown as { callState: unknown }).callState = {
    memberId: seat.memberId, mic: call.mic, cam: call.cam, forced: call.forced, speaking: call.speaking, status: call.status, error: call.error, members: seat.members,
  }
  return (
    <CallProvider call={call}>
      <button id="mic" onClick={() => call.setMic(!call.mic)}>mic {String(call.mic)}</button>
      <button id="cam" onClick={() => call.setCam(!call.cam)}>cam {String(call.cam)}</button>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {seat.members.map((member) => (
          <div
            key={member.id}
            className="tile"
            data-member={member.id}
            data-nickname={member.nickname}
            data-speaking={String(Boolean(call.speaking[member.id]))}
            style={{ width: 320, height: 180, background: '#222', outline: call.speaking[member.id] ? '3px solid lime' : 'none' }}
          >
            {member.cam && !member.hostCamOff && <CallVideo memberId={member.id} />}
            <span>{member.nickname}</span>
            {host && member.id !== seat.memberId && (
              <>
                <button className="mute" onClick={() => call.hostMute(member.id)}>mute</button>
                <button className="camoff" onClick={() => call.hostCamOff(member.id)}>camoff</button>
              </>
            )}
          </div>
        ))}
      </div>
    </CallProvider>
  )
}

function App() {
  const { seat, send, listenerRef } = useRoomSocket()
  if (!seat) return <p>joining</p>
  return <Room seat={seat} send={send} listenerRef={listenerRef} />
}

createRoot(document.getElementById('root')!).render(<App />)
