import { createContext, useContext, type ReactNode } from 'react'

export interface ToastApi {
  toast: (text: ReactNode) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  return api ?? { toast: () => undefined }
}
