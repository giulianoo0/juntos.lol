import { useMemo, type ReactNode } from 'react'
import { Toaster, toast as notify } from 'sonner'
import { ToastContext } from './toastContext'

const TOAST_MS = 2_600

export function ToastProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => ({ toast: (text: ReactNode) => { notify(text) } }), [])
  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster
        position="bottom-left"
        duration={TOAST_MS}
        gap={8}
        visibleToasts={4}
        toastOptions={{ unstyled: true, classNames: { toast: 'ui-toast' } }}
      />
    </ToastContext.Provider>
  )
}
