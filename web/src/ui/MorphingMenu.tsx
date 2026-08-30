import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CLOSE_DURATION, MORPH_EASE, OPEN_DURATION } from './morphTokens'

/**
 * The morphing menu of the app: every control that opens a floating panel —
 * the catalog's filter dropdowns, the room's change-media menu — goes through
 * this one surface.
 *
 * The closed trigger and the open panel share a motion `layoutId`, so opening
 * doesn't pop a surface in — the trigger itself morphs (position, size, border
 * radius) into the panel, and morphs back on close. The panel is portaled to
 * the body and measured against the viewport, opening upward when there is no
 * room below.
 *
 * Close choreography, in order: the panel's content is fully faded out at 60%
 * of the 150ms retract, the shell shrinks empty for the rest, and the
 * trigger's own label only fades back in once the retract morph completes —
 * which is what keeps the shut pill from ever showing its label stretched
 * across a still-shrinking surface.
 *
 * Motion tokens (transitions.dev scale): open 250ms / close 150ms on a
 * smooth-out ease, content swap 2px blur, everything instant under
 * `prefers-reduced-motion`.
 */

/**
 * Fraction of the close morph at which the panel content is fully faded out
 * (0.6 × 150ms = 90ms) — the shell shrinks empty for the remaining 60ms.
 */
const CLOSE_CONTENT_FADE = 0.6
/** Trigger label fade-in after the retract morph completes. */
const TRIGGER_REVEAL_DURATION = 0.13
const VIEWPORT_MARGIN = 8
const PANEL_MAX_HEIGHT = 320
const TRIGGER_RADIUS = 18
const PANEL_RADIUS = 14

type PanelGeometry = {
  /** One of each pair is set, per the align and open direction; viewport coordinates. */
  left: number | null
  right: number | null
  top: number | null
  bottom: number | null
  minWidth: number
  maxWidth: number
  maxHeight: number
}

function measurePanel(trigger: HTMLElement, align: 'start' | 'end', minWidth: number): PanelGeometry {
  const rect = trigger.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  // Anchored by whichever edge lines up with the trigger; the width stays
  // intrinsic (a menu is as wide as its longest row) and the far edge is
  // held off the viewport by the max-width instead of being computed.
  const wanted = Math.max(rect.width, minWidth)
  const anchor = align === 'start'
    ? Math.min(Math.max(rect.left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewportWidth - wanted - VIEWPORT_MARGIN))
    : Math.min(Math.max(viewportWidth - rect.right, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewportWidth - wanted - VIEWPORT_MARGIN))

  const spaceBelow = viewportHeight - rect.top - VIEWPORT_MARGIN
  const spaceAbove = rect.bottom - VIEWPORT_MARGIN
  const openUp = spaceBelow < Math.min(PANEL_MAX_HEIGHT, 280) && spaceAbove > spaceBelow
  // The space clamp wins over the usability floor: a floor larger than the
  // viewport's leftover space would push the panel's first rows off-screen,
  // which is worse than a short panel that scrolls.
  const maxHeight = Math.max(96, Math.min(PANEL_MAX_HEIGHT, openUp ? spaceAbove : spaceBelow))

  return {
    left: align === 'start' ? anchor : null,
    right: align === 'end' ? anchor : null,
    top: openUp ? null : rect.top,
    bottom: openUp ? viewportHeight - rect.bottom : null,
    minWidth: wanted,
    maxWidth: viewportWidth - VIEWPORT_MARGIN * 2,
    maxHeight,
  }
}

interface MorphingMenuProps {
  /** The shut control's row; told whether the surface is open (for a chevron). */
  trigger: (open: boolean) => ReactNode
  /** The panel's contents; call `close` after acting on a row. */
  children: (close: (returnFocus?: boolean) => void) => ReactNode
  /** 'end' anchors the panel to the trigger's right edge. */
  align?: 'start' | 'end'
  /** The panel never opens narrower than this, whatever the trigger's width. */
  minWidth?: number
  haspopup: 'menu' | 'listbox'
  ariaLabel?: string
  triggerClassName?: string
  panelClassName?: string
  /** Fired as the panel opens — for state a caller resets per opening. */
  onOpen?: () => void
  /** 'contextmenu' makes the trigger a right-click target; a click does nothing. */
  openOn?: 'click' | 'contextmenu'
}

export function MorphingMenu({
  trigger,
  children,
  align = 'start',
  minWidth = 230,
  haspopup,
  ariaLabel,
  triggerClassName = '',
  panelClassName = '',
  onOpen,
  openOn = 'click',
}: MorphingMenuProps) {
  const [open, setOpen] = useState(false)
  const [geometry, setGeometry] = useState<PanelGeometry | null>(null)
  // Close choreography: panel content out (fast) → empty shell shrinks →
  // trigger content fades in only after the retract morph completes.
  const [triggerContentVisible, setTriggerContentVisible] = useState(true)

  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closingRef = useRef(false)
  const revealTimeoutRef = useRef<number | undefined>(undefined)

  const reducedMotion = useReducedMotion() ?? false
  const uid = useId()
  const morphId = `morphing-menu-${uid}`
  const panelId = `morphing-menu-panel-${uid}`

  const openTransition = reducedMotion
    ? { duration: 0 }
    : { duration: OPEN_DURATION, ease: MORPH_EASE }
  const closeTransition = reducedMotion
    ? { duration: 0 }
    : { duration: CLOSE_DURATION, ease: MORPH_EASE }

  const revealTriggerContent = useCallback(() => {
    if (!closingRef.current) return
    closingRef.current = false
    window.clearTimeout(revealTimeoutRef.current)
    setTriggerContentVisible(true)
  }, [])

  const openPanel = useCallback(() => {
    const element = triggerRef.current
    if (!element) return
    // Cancel a pending close reveal if the panel reopens mid-retract.
    closingRef.current = false
    window.clearTimeout(revealTimeoutRef.current)
    setTriggerContentVisible(true)
    setGeometry(measurePanel(element, align, minWidth))
    onOpen?.()
    setOpen(true)
  }, [align, minWidth, onOpen])

  const closePanel = useCallback((returnFocus = false) => {
    setOpen(false)
    if (reducedMotion) {
      closingRef.current = false
      setTriggerContentVisible(true)
    } else {
      // Hide the trigger's label for the whole retract morph; it is revealed
      // by onLayoutAnimationComplete (the timeout below is a fallback).
      setTriggerContentVisible(false)
      closingRef.current = true
      window.clearTimeout(revealTimeoutRef.current)
      // The close is two morphs back to back — the content's exit gates
      // unmount for CLOSE_DURATION, and only then does the trigger run its
      // own retract — so the fallback must outlast both, or it re-shows the
      // label mid-shrink: the exact artifact this choreography prevents.
      revealTimeoutRef.current = window.setTimeout(revealTriggerContent, CLOSE_DURATION * 2 * 1000 + 60)
    }
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true })
  }, [reducedMotion, revealTriggerContent])

  useEffect(() => () => window.clearTimeout(revealTimeoutRef.current), [])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Capture-phase intercept so a containing overlay doesn't also close:
      // the panel absorbs this Escape, the next one reaches the host.
      event.preventDefault()
      event.stopPropagation()
      closePanel(true)
    }
    const onScroll = (event: Event) => {
      const panel = panelRef.current
      if (panel && event.target instanceof Node && panel.contains(event.target)) return
      closePanel(false)
    }
    const onResize = () => closePanel(false)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, closePanel])

  return (
    <>
      <motion.button
        ref={triggerRef}
        type="button"
        layoutId={morphId}
        aria-expanded={open}
        aria-haspopup={haspopup}
        aria-controls={panelId}
        aria-label={ariaLabel}
        onClick={openOn === 'click' ? () => (open ? closePanel(true) : openPanel()) : undefined}
        onContextMenu={openOn === 'contextmenu' ? (event) => { event.preventDefault(); if (!open) openPanel() } : undefined}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            openPanel()
          }
        }}
        onLayoutAnimationComplete={revealTriggerContent}
        transition={closeTransition}
        style={{ borderRadius: TRIGGER_RADIUS }}
        className={`morph-menu-trigger ${triggerClassName}`.trim()}
      >
        <motion.span
          className="morph-menu-trigger-row"
          initial={false}
          animate={{ opacity: triggerContentVisible ? 1 : 0 }}
          transition={
            triggerContentVisible && !reducedMotion
              ? { duration: TRIGGER_REVEAL_DURATION, ease: MORPH_EASE }
              : { duration: 0 }
          }
        >
          {trigger(open)}
        </motion.span>
      </motion.button>
      {createPortal(
        <AnimatePresence>
          {open && geometry ? (
            <div
              key="morphing-menu-panel"
              className="morph-menu-backdrop"
              onPointerDown={() => closePanel(false)}
            >
              <motion.div
                ref={panelRef}
                layoutId={morphId}
                id={panelId}
                onPointerDown={(event) => event.stopPropagation()}
                transition={openTransition}
                style={{
                  position: 'absolute',
                  left: geometry.left ?? 'auto',
                  right: geometry.right ?? 'auto',
                  top: geometry.top ?? 'auto',
                  bottom: geometry.bottom ?? 'auto',
                  minWidth: geometry.minWidth,
                  maxWidth: geometry.maxWidth,
                  maxHeight: geometry.maxHeight,
                  borderRadius: PANEL_RADIUS,
                }}
                className={`morph-menu-panel ${panelClassName}`.trim()}
              >
                <motion.div
                  layout
                  className="morph-menu-content"
                  initial={reducedMotion ? false : { opacity: 0, filter: 'blur(2px)' }}
                  animate={{ opacity: 1, filter: 'blur(0px)', transition: openTransition }}
                  exit={
                    reducedMotion
                      ? { opacity: 0, transition: { duration: 0 } }
                      : {
                          // Fully transparent at 60% (~90ms) of the close, then
                          // hold: the shell shrinks empty while presence still
                          // gates unmount for the full 150ms retract morph.
                          opacity: [1, 0, 0],
                          filter: ['blur(0px)', 'blur(2px)', 'blur(2px)'],
                          transition: {
                            duration: CLOSE_DURATION,
                            times: [0, CLOSE_CONTENT_FADE, 1],
                            ease: MORPH_EASE,
                          },
                        }
                  }
                  transition={openTransition}
                >
                  {children(closePanel)}
                </motion.div>
              </motion.div>
            </div>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
