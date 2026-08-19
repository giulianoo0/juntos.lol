import { useCallback, useMemo, useState, type ReactNode } from 'react'
import * as ToastPrimitive from '@radix-ui/react-toast'
import { ToastContext } from './toastContext'

// A transient confirmation. Toasts are announced politely rather than
// interrupting, because none of them report anything the viewer must act on.
interface ToastMessage {
  id: number
  text: string
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([])

  const toast = useCallback((text: string) => {
    // A monotonic id rather than an index: repeated confirmations of the same
    // action have to re-enter, not silently reuse a live toast.
    setMessages((current) => [...current.slice(-2), { id: Date.now() + current.length, text }])
  }, [])

  const api = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={api}>
      <ToastPrimitive.Provider swipeDirection="left" duration={2400}>
        {children}
        {messages.map((message) => (
          <ToastPrimitive.Root
            key={message.id}
            className="ui-toast"
            onOpenChange={(open) => {
              if (!open) setMessages((current) => current.filter((item) => item.id !== message.id))
            }}
          >
            <ToastPrimitive.Description>{message.text}</ToastPrimitive.Description>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="ui-toast-viewport" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  )
}
