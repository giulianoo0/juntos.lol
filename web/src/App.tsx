import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { CodecSupportNotice } from './components/CodecSupport'
import type { CreateRoomInput } from './pages/Home'

const Home = lazy(() => import('./pages/Home').then((module) => ({ default: module.Home })))
const RoomPage = lazy(() => import('./pages/Room').then((module) => ({ default: module.RoomPage })))
const DevRoom = lazy(() => import('./room/ui/DevRoom').then((module) => ({ default: module.DevRoom })))

// Until the room is born empty (`POST /api/rooms {nickname, name}`) and takes
// a password (`joinMode`), the Home opens the room the old way, without them.
async function createRoom(_input: CreateRoomInput): Promise<{ roomID: string }> {
  const { createScreenRoom } = await import('./upload')
  const room = await createScreenRoom(localStorage.getItem('ss.nickname') ?? '')
  try { localStorage.setItem('ss.nickname', room.nickname) } catch {}
  return { roomID: room.roomID }
}

export default function App() {
  return (
    <BrowserRouter>
      <CodecSupportNotice />
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Home createRoom={createRoom} />} />
          <Route path="/room/:id" element={<RoomPage />} />
          <Route path="/dev/sala" element={<DevRoom />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
