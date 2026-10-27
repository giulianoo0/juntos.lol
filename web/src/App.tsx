import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { CodecSupportNotice } from './components/CodecSupport'
import type { CreateRoomInput } from './pages/Home'

const Home = lazy(() => import('./pages/Home').then((module) => ({ default: module.Home })))
const AccountPage = lazy(() => import('./pages/Account').then((module) => ({ default: module.AccountPage })))
const RoomPage = lazy(() => import('./pages/Room').then((module) => ({ default: module.RoomPage })))
const DevRoom = lazy(() => import('./room/ui/DevRoom').then((module) => ({ default: module.DevRoom })))

async function createRoom(input: CreateRoomInput): Promise<{ roomID: string }> {
  const { createEmptyRoom } = await import('./upload')
  const room = await createEmptyRoom(localStorage.getItem('ss.nickname') ?? '', input.name || undefined, input.password || undefined)
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
          <Route path="/conta" element={<AccountPage />} />
          <Route path="/u/:id" element={<AccountPage />} />
          <Route path="/dev/sala" element={<DevRoom />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
