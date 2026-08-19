import { createContext, useContext } from 'react'

export interface ToastApi {
  toast: (text: string) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  // A component that toasts outside a provider should say nothing rather than
  // crash the page it is part of.
  return api ?? { toast: () => undefined }
}
