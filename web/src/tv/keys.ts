/**
 * The remote, read as what it asks for. Tizen and webOS send their own key
 * codes for Back and the transport keys; a browser sends the names, which is
 * how the page is tried on a desktop.
 */
export type TvKeyAction =
  | 'up' | 'down' | 'left' | 'right' | 'enter' | 'back'
  | 'playPause' | 'play' | 'pause' | 'forward' | 'rewind' | 'menu'

const BY_CODE: Record<number, TvKeyAction> = {
  38: 'up',
  40: 'down',
  37: 'left',
  39: 'right',
  13: 'enter',
  10009: 'back',
  461: 'back',
  10252: 'playPause',
  415: 'play',
  19: 'pause',
  417: 'forward',
  412: 'rewind',
  403: 'menu',
  457: 'menu',
}

const BY_KEY: Record<string, TvKeyAction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'enter',
  Escape: 'back',
  Backspace: 'back',
  GoBack: 'back',
  BrowserBack: 'back',
  XF86Back: 'back',
  MediaPlayPause: 'playPause',
  MediaPlay: 'play',
  MediaPause: 'pause',
  MediaFastForward: 'forward',
  MediaRewind: 'rewind',
  ColorF0Red: 'menu',
  ContextMenu: 'menu',
  Info: 'menu',
}

export function tvKeyAction(event: { key: string; keyCode: number }): TvKeyAction | null {
  return BY_CODE[event.keyCode] ?? BY_KEY[event.key] ?? null
}

/**
 * The transport keys as the player's own shortcuts (k, l, j: play/pause and
 * ±10 s), so the remote steers the room with the player's rules and messages.
 * Play on a playing video, or pause on a paused one, is nothing to do.
 */
export function playerKeyFor(action: 'playPause' | 'play' | 'pause' | 'forward' | 'rewind', paused: boolean): string | null {
  switch (action) {
    case 'forward': return 'l'
    case 'rewind': return 'j'
    case 'play': return paused ? 'k' : null
    case 'pause': return paused ? null : 'k'
    case 'playPause': return 'k'
  }
}

/** Tizen only delivers the transport keys and the colours to a page that asks for them. */
const TIZEN_KEYS = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind', 'ColorF0Red', 'Info']

export interface TizenHost {
  tizen?: {
    tvinputdevice?: { registerKey(name: string): void }
    application?: { getCurrentApplication(): { exit(): void } }
  }
}

export function registerTvKeys(host: TizenHost = window as TizenHost): void {
  const input = host.tizen?.tvinputdevice
  if (!input) return
  for (const name of TIZEN_KEYS) {
    try { input.registerKey(name) } catch { /* a model without this key */ }
  }
}

export type TvPlatform = 'tizen' | 'webos' | 'browser'

/**
 * Which TV this is. The Samsung shell holds the page in an iframe, where
 * `tizen` does not reach, and says so with a message as the page loads; the
 * LG one hands the page the whole window. Without either, the user agent tells.
 */
export function shellPlatform(message: unknown, userAgent: string): TvPlatform {
  const shell = message as { type?: unknown; platform?: unknown } | null
  if (shell?.type === 'juntos-tv:shell' && (shell.platform === 'tizen' || shell.platform === 'webos')) return shell.platform
  if (/Web0S|webOS/.test(userAgent)) return 'webos'
  if (/Tizen/.test(userAgent)) return 'tizen'
  return 'browser'
}

let platform: TvPlatform = typeof navigator === 'undefined' ? 'browser' : shellPlatform(null, navigator.userAgent)

/** Listens for the shell's hello; installed once, as the TV page starts. */
export function listenForShell(): () => void {
  const onMessage = (event: MessageEvent) => {
    const said = shellPlatform(event.data, '')
    if (said !== 'browser') platform = said
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

interface ExitHost extends TizenHost {
  close(): void
  parent?: { postMessage(message: unknown, target: string): void }
}

/**
 * Back to the TV's launcher: Tizen's own call where it reaches, the Samsung
 * shell's message from inside its iframe, and closing the window on webOS.
 */
export function exitTvApp(host: ExitHost = window as unknown as ExitHost, on: TvPlatform = platform): void {
  try {
    const app = host.tizen?.application?.getCurrentApplication()
    if (app) { app.exit(); return }
  } catch { /* not Tizen after all */ }
  if (on === 'tizen' && host.parent && host.parent !== (host as unknown)) {
    host.parent.postMessage({ type: 'juntos-tv:exit' }, '*')
    return
  }
  host.close()
}
