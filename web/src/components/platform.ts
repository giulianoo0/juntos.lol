/**
 * What the page can tell about where it is running, for the two places that
 * genuinely need it: which ss-bridge build to offer, and where the browser is
 * about to draw its local-network permission prompt.
 *
 * Local Network Access (Chrome 142+, Firefox) gates any request from a public
 * site to 127.0.0.1 behind a permission the user has to grant. The prompt is
 * browser UI, so the page cannot see it — the best it can do is point at where
 * it lands, and it only lands in the same place on desktop:
 *
 *   - Chromium (Chrome, Edge, Opera, Brave) and Firefox on desktop anchor the
 *     prompt under the left edge of the address bar, the same spot the camera
 *     and microphone prompts use. That is true on macOS, Windows and Linux
 *     alike: the toolbar sits inside the window on all three, so the anchor is
 *     always just above the top-left corner of the viewport.
 *   - On phones there is no fixed anchor to point at. Chrome and Firefox for
 *     Android both let the user move the address bar to the bottom of the
 *     screen, and the prompt itself is a dialog rather than a bubble, so the
 *     honest hint is "answer the dialog", with no arrow.
 *   - Safari does not ask per site. What can appear instead is a macOS system
 *     alert asking to let Safari itself find devices on the local network,
 *     which is centred on the screen and outside the browser window entirely.
 *
 * Separately from any of that, macOS (Sequoia and later) gates local network
 * access per application: even a granted browser permission does nothing until
 * the browser itself is allowed under System Settings › Privacy & Security ›
 * Local Network. Windows and Linux have no equivalent.
 */

export type Os = 'mac' | 'windows' | 'linux'
export type Browser = 'chromium' | 'firefox' | 'safari' | 'other'

/** Where the permission prompt will show up, as far as the page can point. */
export type PromptAnchor =
  // A bubble under the left edge of the address bar: an arrow can reach it.
  | 'address-bar'
  // A dialog the user answers, with nowhere reliable to point.
  | 'dialog'
  // No per-site prompt at all (Safari); at most an OS alert.
  | 'system'

function ua(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent
}

export function detectOs(): Os {
  const agent = ua()
  if (/Win/i.test(agent)) return 'windows'
  if (/Linux|X11|Android|CrOS/i.test(agent)) return 'linux'
  return 'mac'
}

export function detectBrowser(): Browser {
  const agent = ua()
  // Order matters: every Chromium brand also says "Safari", and the iOS
  // wrappers say their own brand while running WebKit underneath.
  if (/Firefox\/|FxiOS\//.test(agent)) return 'firefox'
  if (/Edg[A-Z]*\/|OPR\/|OPiOS\/|Chrome\/|Chromium\/|CriOS\//.test(agent)) return 'chromium'
  if (/Safari\//.test(agent)) return 'safari'
  return 'other'
}

export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  const agent = ua()
  if (/Android|iPhone|iPod|iPad/i.test(agent)) return true
  // iPadOS reports itself as a Mac; the touch points give it away.
  return /Macintosh/.test(agent) && navigator.maxTouchPoints > 1
}

export function promptAnchor(): PromptAnchor {
  if (isMobile()) return 'dialog'
  const browser = detectBrowser()
  if (browser === 'chromium' || browser === 'firefox') return 'address-bar'
  if (browser === 'safari') return 'system'
  return 'dialog'
}
