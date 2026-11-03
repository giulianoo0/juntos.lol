import './polyfills'
import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '../styles/tokens.css'
import '../theme.css'
import { ToastProvider } from '../ui/Toast'
import { installAudioUnlock } from '../ui/audioUnlock'
import { applyTheme } from '../ui/theme'
import { TvApp } from './TvApp'

// The TV's own entry, built apart for the old Chromium of TVs (Tizen 5 is 63,
// webOS 4 is 53): only the page that watches, none of the site around it.
applyTheme()
installAudioUnlock()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={null}><TvApp /></Suspense>
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
)
