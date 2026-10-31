/**
 * Keeps a text field from swallowing what was typed: Radix's focus scope (and
 * some programmatic focus) hands focus back with the whole value selected, so
 * the next key would replace it. A full selection on focus collapses to the end.
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
