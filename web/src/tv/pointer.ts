/**
 * The LG Magic Remote is a mouse: hovering focuses what is under it, and
 * while it moves the arrows' focus ring steps aside (`data-pointer` on the
 * root). webOS sends a keydown Enter and a click for one OK press with the
 * cursor up, so a second click right after an Enter is dropped.
 */
const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
const ENTER_CLICK_DEDUPE_MS = 350

export function installPointer(): () => void {
  const root = document.documentElement
  let lastX = -1
  let lastY = -1
  let enterAt = 0
  let clicksSinceEnter = 0

  const onMove = (event: MouseEvent) => {
    // A row that scrolls under a resting cursor fires moves at the same spot; only a real one counts.
    if (event.clientX === lastX && event.clientY === lastY) return
    lastX = event.clientX
    lastY = event.clientY
    root.dataset.pointer = ''
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(FOCUSABLE) : null
    if (target && document.activeElement !== target) target.focus({ preventScroll: true })
  }
  const onKey = (event: KeyboardEvent) => {
    delete root.dataset.pointer
    if (event.key === 'Enter' || event.keyCode === 13) {
      enterAt = Date.now()
      clicksSinceEnter = 0
    }
  }
  const onClick = (event: MouseEvent) => {
    if (Date.now() - enterAt > ENTER_CLICK_DEDUPE_MS) return
    clicksSinceEnter += 1
    if (clicksSinceEnter > 1) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('click', onClick, true)
  return () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('click', onClick, true)
  }
}
