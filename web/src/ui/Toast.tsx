import { useMemo, type ReactNode } from 'react'
import { Toaster, toast as notify } from 'sonner'
import { ToastContext } from './toastContext'

// Long enough to read a short confirmation, short enough that a burst of them
// drains rather than stacking up over the picture.
const TOAST_MS = 2_600

/**
 * One notification surface for the whole app.
 *
 * Confirmations, refusals and arrivals used to be three different things: a
 * Radix toast bottom-left, a hand-rolled stack top-right, and nothing at all
 * for some of it. They say the same kind of thing — something happened, you
 * need not act — so they now look and behave the same and queue together.
 *
 * The context wrapper stays so that call sites, and the tests around them,
 * keep talking to the app rather than to whichever library is behind it.
 */
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
        // Ours entirely: sonner's default card is a light-mode surface, and
        // these sit over a dark room and a playing picture.
        toastOptions={{ unstyled: true, classNames: { toast: 'ui-toast' } }}
      />
    </ToastContext.Provider>
  )
}
