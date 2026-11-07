/**
 * The wire to one extension's iframe. A message counts only when it comes
 * from that iframe's window and from the extension's own origin, and passes
 * the protocol; what the page sends goes to that origin alone.
 */
import { extensionOrigin, parseExtMessage, type ExtSource, type ExtToHost, type ExtensionManifest, type ExtensionPlace, type HostToExt, type ThemeTokens } from './protocol'
import { themeTokens } from './theme'

export interface LoadedExtension {
  id: string
  sub: string
  version: string
  manifest: ExtensionManifest
}

export const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups'

const REFRESH_WAIT_MS = 20_000

export function frameSrc(extension: LoadedExtension, place?: ExtensionPlace): string {
  return `${extensionOrigin(extension.sub, place)}/@${encodeURIComponent(extension.version)}/${extension.manifest.entry}`
}

/** Points the iframe at the extension, isolated: no top navigation, no referrer, no powerful features. */
export function dressFrame(frame: HTMLIFrameElement, extension: LoadedExtension, place?: ExtensionPlace): void {
  frame.setAttribute('sandbox', FRAME_SANDBOX)
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.setAttribute('allow', '')
  frame.src = frameSrc(extension, place)
}

export interface InitFields {
  theme: ThemeTokens
  locale: string
  canPlay: boolean
}

export interface Bridge {
  post(message: HostToExt): void
  close(): void
}

/** Listens for the iframe's messages; answers `ready` with `init` and hands the rest on. */
export function connectFrame(
  frame: HTMLIFrameElement,
  extension: LoadedExtension,
  place: ExtensionPlace | undefined,
  init: () => InitFields,
  onMessage: (message: ExtToHost) => void,
): Bridge {
  const origin = extensionOrigin(extension.sub, place)
  const post = (message: HostToExt) => frame.contentWindow?.postMessage(message, origin)
  const listen = (event: MessageEvent) => {
    if (event.origin !== origin || event.source === null || event.source !== frame.contentWindow) return
    const message = parseExtMessage(event.data, extension.manifest)
    if (!message) return
    if (message.type === 'ready') post({ juntos: 1, type: 'init', ...init() })
    onMessage(message)
  }
  window.addEventListener('message', listen)
  return { post, close: () => window.removeEventListener('message', listen) }
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Asks the extension, loaded out of sight, for a fresh source for `ref`: a
 * preparo resumed after a reload cannot reuse the old url, whose signature
 * is long gone. Null when it has none or does not answer in time.
 */
export function refreshSource(extension: LoadedExtension, place: ExtensionPlace | undefined, ref: string, locale = 'pt-BR'): Promise<ExtSource | null> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    const asked = nonce()
    let finished = false
    const finish = (source: ExtSource | null) => {
      if (finished) return
      finished = true
      window.clearTimeout(timer)
      bridge.close()
      frame.remove()
      resolve(source)
    }
    const bridge = connectFrame(frame, extension, place, () => ({ theme: themeTokens(), locale, canPlay: true }), (message) => {
      if (message.type === 'ready') bridge.post({ juntos: 1, type: 'refresh', nonce: asked, ref })
      else if (message.type === 'refreshed' && message.nonce === asked) finish(message.source)
    })
    const timer = window.setTimeout(() => finish(null), REFRESH_WAIT_MS)
    dressFrame(frame, extension, place)
    document.body.append(frame)
  })
}
