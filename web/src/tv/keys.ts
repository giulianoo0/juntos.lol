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

/** Back to the TV's launcher: Tizen has its own call, webOS closes the window. */
export function exitTvApp(host: TizenHost & { close(): void } = window as TizenHost & Window): void {
  try {
    const app = host.tizen?.application?.getCurrentApplication()
    if (app) { app.exit(); return }
  } catch { /* not Tizen after all */ }
  host.close()
}
