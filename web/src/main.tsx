import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './theme.css'
import App from './App.tsx'
import { ToastProvider } from './ui/Toast'
import { installMockApi } from './mocks'
import { markEngine } from './engine'
import { registerYoutubeBackend } from './youtube'
import { jlocalBackend } from './jlocal/youtube'
import { desktopYoutubeBackend } from './desktop/sources'
import { installAudioUnlock } from './ui/audioUnlock'
import { applyTheme } from './ui/theme'

applyTheme()
markEngine()
installMockApi()
installAudioUnlock()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
)

registerYoutubeBackend(jlocalBackend)
// Inside the desktop app, yt-dlp on this machine goes first.
registerYoutubeBackend(desktopYoutubeBackend)

// One page load for /data's tally: nothing in it names the browser.
try { navigator.sendBeacon?.('/api/visit') } catch {}

const checkPlugins = () => { void import('./plugins/update').then(({ updateAll }) => updateAll()).catch(() => undefined) }
const idle = window.requestIdleCallback
if (typeof idle === 'function') idle(checkPlugins, { timeout: 3_000 })
else window.setTimeout(checkPlugins, 1_500)
