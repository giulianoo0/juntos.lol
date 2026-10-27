import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => unknown }

/**
 * A link whose page change runs inside a view transition, so what both
 * pages name alike (the logo) morphs from one place to the other. Where
 * the browser has no view transitions it is a plain link.
 */
export const MorphLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & {
  to: string
  state?: unknown
}>(function MorphLink({ to, state, onClick, ...rest }, ref) {
  const navigate = useNavigate()
  const go = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    const doc = document as ViewTransitionDocument
    if (event.defaultPrevented || !doc.startViewTransition || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    event.preventDefault()
    doc.startViewTransition(() => flushSync(() => navigate(to, { state })))
  }
  return <Link ref={ref} to={to} state={state} onClick={go} {...rest} />
})
