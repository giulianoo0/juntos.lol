import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { CodecSupportNotice } from './components/CodecSupport'

const Home = lazy(() => import('./pages/Home').then((module) => ({ default: module.Home })))
const RoomPage = lazy(() => import('./pages/Room').then((module) => ({ default: module.RoomPage })))

export default function App() {
  return (
    <BrowserRouter>
      <CodecSupportNotice />
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/catalog" element={<Home />} />
          <Route path="/status" element={<Home />} />
          <Route path="/title/:type/:id" element={<Home />} />
          <Route path="/room/:id" element={<RoomPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
