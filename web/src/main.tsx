import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.css'
import App from './App.tsx'
import { ToastProvider } from './ui/Toast'
import { installMockApi } from './mocks'

installMockApi()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
)

const checkPlugins = () => { void import('./plugins/update').then(({ updateAll }) => updateAll()).catch(() => undefined) }
const idle = window.requestIdleCallback
if (typeof idle === 'function') idle(checkPlugins, { timeout: 3_000 })
else window.setTimeout(checkPlugins, 1_500)
