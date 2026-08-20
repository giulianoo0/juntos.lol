import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { CodecSupportNotice } from './components/CodecSupport'
import { Home } from './pages/Home'
import { RoomPage } from './pages/Room'

export default function App() {
  return (
    <BrowserRouter>
      {/* Above the routes, so arriving at the site and arriving straight into
          a room both raise it — and neither raises it twice on navigation. */}
      <CodecSupportNotice />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/room/:id" element={<RoomPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
