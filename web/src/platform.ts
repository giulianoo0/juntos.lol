/**
 * Where the page runs: a browser tab, or the Juntos desktop app (Tauri),
 * which loads this same site and lends it a few narrow commands over its
 * IPC. The app answers a hello first; one on another protocol counts as
 * absent, so an old app never gets calls it does not understand.
 */

/** Must match PROTOCOL_VERSION in desktop/src-tauri/src/site.rs. */
export const DESKTOP_PROTOCOL = 1

export interface DesktopApp {
  version: string
  /** Where the cache is served to this page: `<mediaRoot>/<key>/hls/<name>`. */
  mediaRoot: string
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
}

interface Hello {
  protocolVersion: number
  version: string
  compatible: boolean
  mediaRoot: string
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

function bridge(): Invoke | null {
  if (typeof window === 'undefined') return null
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__
  return typeof internals?.invoke === 'function' ? internals.invoke.bind(internals) : null
}

let handshake: Promise<DesktopApp | null> | null = null
let refused = false

/** Whether the app carries this page (before the hello settles, it is assumed to). */
export function isDesktop(): boolean {
  return bridge() !== null && !refused
}

/** The app, once its hello says it speaks this protocol; null in a browser. */
export function desktop(): Promise<DesktopApp | null> {
  if (handshake) return handshake
  const invoke = bridge()
  if (!invoke) return Promise.resolve(null)
  handshake = (async () => {
    try {
      const hello = await invoke('app_hello', { protocolVersion: DESKTOP_PROTOCOL }) as Hello
      if (!hello?.compatible) {
        refused = true
        return null
      }
      return {
        version: hello.version,
        mediaRoot: hello.mediaRoot,
        invoke: <T,>(cmd: string, args?: Record<string, unknown>) => invoke(cmd, args) as Promise<T>,
      }
    } catch (error) {
      console.warn('desktop app hello failed', error)
      refused = true
      return null
    }
  })()
  return handshake
}

export function resetDesktopForTests(): void {
  handshake = null
  refused = false
}
