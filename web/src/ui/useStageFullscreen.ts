import { useCallback, useEffect, useState, type RefObject } from 'react'

type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

function currentFullscreen(): Element | null {
  const doc = document as FullscreenDocument
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

/**
 * Fullscreen for a whole stage, controls and overlays included: the
 * Fullscreen API where the browser has it for elements, and on an iPhone,
 * which only fullscreens a bare <video>, the stage pinned over the page
 * instead. The caller puts `is-pseudo-fullscreen` on the stage while
 * `pinned` is true.
 */
export function useStageFullscreen(stageRef: RefObject<HTMLElement | null>): { fullscreen: boolean; pinned: boolean; toggle: () => void } {
  const [native, setNative] = useState(false)
  const [pseudo, setPseudo] = useState(false)

  useEffect(() => {
    const update = () => setNative(stageRef.current !== null && currentFullscreen() === stageRef.current)
    document.addEventListener('fullscreenchange', update)
    document.addEventListener('webkitfullscreenchange', update)
    return () => {
      document.removeEventListener('fullscreenchange', update)
      document.removeEventListener('webkitfullscreenchange', update)
    }
  }, [stageRef])

  useEffect(() => {
    if (!pseudo) return
    document.documentElement.classList.add('has-pseudo-fullscreen')
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setPseudo(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.documentElement.classList.remove('has-pseudo-fullscreen')
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [pseudo])

  const toggle = useCallback(() => {
    const doc = document as FullscreenDocument
    if (pseudo) {
      setPseudo(false)
      return
    }
    if (currentFullscreen()) {
      const exit = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc)
      void Promise.resolve(exit?.()).catch(() => undefined)
      return
    }
    const stage = stageRef.current as FullscreenElement | null
    if (!stage) return
    const request = stage.requestFullscreen?.bind(stage) ?? stage.webkitRequestFullscreen?.bind(stage)
    if (!request) {
      setPseudo(true)
      return
    }
    void Promise.resolve(request()).catch(() => setPseudo(true))
  }, [pseudo, stageRef])

  return { fullscreen: native || pseudo, pinned: pseudo, toggle }
}
