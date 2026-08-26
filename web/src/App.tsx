import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { CodecSupportNotice } from './components/CodecSupport'

// The two routes have almost nothing in common: the home page carries the
// catalog, the onboarding and the whole motion library; a room carries the
// player, the sync layer and the subtitle engine. Imported statically they
// were one chunk, and a room link paid for the catalog before it could draw
// a frame. The fallback is null on purpose — until the split, the page was
// blank while that single bundle parsed anyway.
const Home = lazy(() => import('./pages/Home').then((module) => ({ default: module.Home })))
const RoomPage = lazy(() => import('./pages/Room').then((module) => ({ default: module.RoomPage })))

export default function App() {
  return (
    <BrowserRouter>
      {/* Above the routes, so arriving at the site and arriving straight into
          a room both raise it — and neither raises it twice on navigation. */}
      <CodecSupportNotice />
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Home />} />
          {/* The header's tabs are routes, so a catalogue or the fleet's
              status is a place someone can link to, bookmark, and come back
              to with the browser's own back button. */}
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
