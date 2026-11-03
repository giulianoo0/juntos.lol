import { useEffect, useRef } from 'react'
import { tvKeyAction, type TvKeyAction } from './keys'
import { moveFocus, openOverlay } from './spatial'

export type MediaAction = 'playPause' | 'play' | 'pause' | 'forward' | 'rewind'

export interface RemoteHandlers {
  /** Back with nothing of the page's own open: the TV's panels, then the question to stop or leave. */
  onBack(): void
  onMenu(): void
  onMedia(action: MediaAction): void
  /** Asked first: true when the room took the key itself (the bar, OK held). */
  onKey?(action: TvKeyAction, repeat: boolean): boolean
  /** OK let go, for telling a press from a hold. */
  onEnterUp?(): void
}

const isSlider = (element: Element | null) => element instanceof HTMLInputElement && element.type === 'range'

/**
 * The remote over the page, ahead of everything else on it: arrows move the
 * focus (the player's own arrow keys never see them), Back closes what is open
 * and otherwise asks the TV, the transport keys go to the media.
 */
export function useRemote(handlers: RemoteHandlers): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = tvKeyAction(event)
      if (!action) return
      if (handlersRef.current.onKey?.(action, event.repeat)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      const active = document.activeElement
      switch (action) {
        case 'up':
        case 'down':
        case 'left':
        case 'right':
          if (isSlider(active) && (action === 'left' || action === 'right')) return
          event.preventDefault()
          moveFocus(action)
          return
        case 'enter':
          return
        case 'back': {
          const overlay = openOverlay()
          if (overlay && !overlay.hasAttribute('data-tv-overlay')) {
            // A menu or dialog of the page closes on Escape; a real Escape already is one.
            if (event.key === 'Escape') return
            event.preventDefault()
            const target = active instanceof HTMLElement ? active : document.body
            target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }))
            return
          }
          event.preventDefault()
          handlersRef.current.onBack()
          return
        }
        case 'menu':
          event.preventDefault()
          handlersRef.current.onMenu()
          return
        default:
          event.preventDefault()
          handlersRef.current.onMedia(action)
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (tvKeyAction(event) === 'enter') handlersRef.current.onEnterUp?.()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [])
}
