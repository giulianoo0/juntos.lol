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
