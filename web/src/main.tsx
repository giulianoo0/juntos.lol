import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.css'
import App from './App.tsx'
import { ToastProvider } from './ui/Toast'
import { installMockApi } from './mocks'

// No-op unless the build was started with VITE_MOCK=1 (`npm run dev:mock`).
installMockApi()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
)

// Plugins check their locked origin once per load. Deliberately not awaited
// and deliberately silent: an update is never the reason the catalog takes
// longer to appear, and a failed network call is not an event.
void import('./plugins/update').then(({ updateAll }) => updateAll()).catch(() => undefined)
