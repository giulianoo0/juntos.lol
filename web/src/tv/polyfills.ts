// What the old Chromium of TVs lacks and core-js does not bring: AbortController
// (66), ResizeObserver (64), AbortSignal.timeout and crypto.randomUUID (92).
// Imported first by the TV's entry, before anything that uses them.
import 'abortcontroller-polyfill/dist/polyfill-patch-fetch'
import ResizeObserverPolyfill from 'resize-observer-polyfill'

const scope = window as unknown as Record<string, unknown>
if (!scope.ResizeObserver) scope.ResizeObserver = ResizeObserverPolyfill

if (typeof AbortSignal !== 'undefined' && !('timeout' in AbortSignal)) {
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    value: (ms: number) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), ms)
      return controller.signal
    },
  })
}

if (window.crypto && !('randomUUID' in window.crypto)) {
  Object.defineProperty(window.crypto, 'randomUUID', {
    configurable: true,
    value: () => {
      const bytes = window.crypto.getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    },
  })
}

// Intl.NumberFormat#formatToParts (64): the animated numbers read the parts.
// Rebuilt from format() and the locale's own separators.
type Part = { type: string; value: string }
const numberFormat = Intl.NumberFormat.prototype as unknown as { formatToParts?: (this: Intl.NumberFormat, value: number) => Part[] }
if (typeof numberFormat.formatToParts !== 'function') {
  numberFormat.formatToParts = function formatToParts(this: Intl.NumberFormat, value: number): Part[] {
    const probe = new Intl.NumberFormat(this.resolvedOptions().locale, { useGrouping: true, minimumFractionDigits: 1 }).format(11111.1)
    const symbols = probe.replace(/\d/g, '')
    const decimal = symbols.slice(-1)
    const group = symbols.length > 1 ? symbols.charAt(0) : ''
    const parts: Part[] = []
    let fraction = false
    const push = (type: string, char: string) => {
      const last = parts[parts.length - 1]
      if (last && last.type === type && (type === 'integer' || type === 'fraction' || type === 'literal')) last.value += char
      else parts.push({ type, value: char })
    }
    for (const char of this.format(value)) {
      if (/\d/.test(char)) push(fraction ? 'fraction' : 'integer', char)
      else if (char === decimal && !fraction) { fraction = true; push('decimal', char) }
      else if (char === group && !fraction) push('group', char)
      else if (char === '-' || char === '−') push('minusSign', char)
      else if (char === '+') push('plusSign', char)
      else if (char === '%') push('percentSign', char)
      else push('literal', char)
    }
    return parts
  }
}
