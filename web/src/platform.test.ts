import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_MIN_PROTOCOL, DESKTOP_PROTOCOL, appChrome, appUpdateRequired, desktop, isDesktop, resetDesktopForTests } from './platform'

type Internals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }

function installApp(invoke: Internals['invoke']): ReturnType<typeof vi.fn> {
  const spy = vi.fn(invoke)
  ;(window as unknown as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__ = { invoke: spy }
  resetDesktopForTests()
  return spy
}

const compatible = { protocolVersion: DESKTOP_PROTOCOL, version: '0.1.0', compatible: true, features: ['localSource'], mediaRoot: 'juntos-media://localhost' }

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__
  resetDesktopForTests()
})

describe('platform', () => {
  it('is the browser when no app carries the page', async () => {
    expect(isDesktop()).toBe(false)
    expect(await desktop()).toBeNull()
  })

  it('shakes hands once and passes the commands through', async () => {
    const invoke = installApp(async (cmd) => (cmd === 'app_hello' ? compatible : 'pong'))
    expect(isDesktop()).toBe(true)
    const app = await desktop()
    expect(app?.version).toBe('0.1.0')
    expect(app?.mediaRoot).toBe('juntos-media://localhost')
    expect(await app?.invoke('torrent_stats', { id: 'x' })).toBe('pong')
    await desktop()
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'app_hello')).toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith('app_hello', expect.objectContaining({ protocolVersion: DESKTOP_PROTOCOL }))
  })

  it('tells the app the oldest protocol this site still talks to', async () => {
    const invoke = installApp(async () => compatible)
    await desktop()
    expect(invoke).toHaveBeenCalledWith('app_hello', { protocolVersion: DESKTOP_PROTOCOL, minProtocolVersion: DESKTOP_MIN_PROTOCOL })
    expect(await appUpdateRequired()).toBe(false)
  })

  it('treats an app too old for the site as absent, and asks for its update', async () => {
    installApp(async () => ({ ...compatible, compatible: false, updateRequired: true, features: [] }))
    expect(await desktop()).toBeNull()
    expect(isDesktop()).toBe(false)
    expect(await appUpdateRequired()).toBe(true)
  })

  it('treats an app that refuses the hello as absent', async () => {
    installApp(async () => { throw new Error('not allowed') })
    expect(await desktop()).toBeNull()
  })

  it('draws the window buttons only for an app that hands the title bar to the page', async () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
    const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0'
    installApp(async () => ({ ...compatible, features: ['localSource', 'titleBar'] }))
    const app = await desktop()
    expect(appChrome(app, mac)).toBe('mac')
    expect(appChrome(app, windows)).toBe('windows')
    expect(appChrome(app, 'Mozilla/5.0 (X11; Linux x86_64)')).toBeNull()
    installApp(async () => compatible)
    expect(appChrome(await desktop(), mac)).toBeNull()
    expect(appChrome(null, mac)).toBeNull()
  })
})
