import { lazy, Suspense } from 'react'
import { NotFoundPage } from './components/LostPage'
import { Route, Routes, UNSAFE_createBrowserHistory as createBrowserHistory, unstable_HistoryRouter as HistoryRouter } from 'react-router-dom'
import { deferPops } from './backForward'
import { CodecSupportNotice } from './components/CodecSupport'
import { RoomHost } from './components/RoomHost'
import { DownloadAppHost } from './components/DownloadApp'
import { AppUpdate } from './components/AppUpdate'
import type { CreateRoomInput } from './pages/Home'

const Home = lazy(() => import('./pages/Home').then((module) => ({ default: module.Home })))
const AccountPage = lazy(() => import('./pages/Account').then((module) => ({ default: module.AccountPage })))
const LegacyProfile = lazy(() => import('./pages/Account').then((module) => ({ default: module.LegacyProfile })))
const DataPage = lazy(() => import('./pages/Data').then((module) => ({ default: module.DataPage })))
const DevRoom =lazy(() => import('./room/ui/DevRoom').then((module) => ({ default: module.DevRoom })))

async function createRoom(input: CreateRoomInput): Promise<{ roomID: string }> {
  const { createEmptyRoom } = await import('./upload')
  const room = await createEmptyRoom(localStorage.getItem('ss.nickname') ?? '', input.name || undefined, input.password || undefined)
  try { localStorage.setItem('ss.nickname', room.nickname) } catch {}
  return { roomID: room.roomID }
}

const history = deferPops(createBrowserHistory({ v5Compat: true }))

export default function App() {
  return (
    <HistoryRouter history={history}>
      <CodecSupportNotice />
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Home createRoom={createRoom} />} />
          <Route path="/room/:id" element={null} />
          <Route path="/conta" element={<AccountPage />} />
          <Route path="/c/:id" element={<AccountPage />} />
          <Route path="/u/:id" element={<LegacyProfile />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="/dev/sala" element={<DevRoom />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        <RoomHost />
        <DownloadAppHost />
        <AppUpdate />
      </Suspense>
    </HistoryRouter>
  )
}
