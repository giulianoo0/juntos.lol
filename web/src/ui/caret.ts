/**
 * Keeps a text field from swallowing what was typed.
 *
 * Radix's focus scope hands focus back to a field with its whole value
 * selected, and so does the browser on a programmatic focus in some
 * cases — so a re-render that lets focus slip for a frame comes back
 * with everything highlighted, and the next key replaces the name being
 * typed. A selection that spans the entire value at the moment focus
 * arrives is never something the person did with the keyboard mid-word;
 * it collapses to the end, where the next letter belongs.
 */
import type { FocusEvent } from 'react'

export function caretToEndOnFocus(event: FocusEvent<HTMLInputElement>): void {
  const input = event.currentTarget
  requestAnimationFrame(() => {
    if (document.activeElement !== input) return
    const length = input.value.length
    if (length > 0 && input.selectionStart === 0 && input.selectionEnd === length) {
      input.setSelectionRange(length, length)
    }
  })
}
