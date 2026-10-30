import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_PROTOCOL, desktop, isDesktop, resetDesktopForTests } from './platform'

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
    expect(invoke).toHaveBeenCalledWith('app_hello', { protocolVersion: DESKTOP_PROTOCOL })
  })

  it('treats an app on another protocol as absent', async () => {
    installApp(async () => ({ ...compatible, compatible: false, features: [] }))
    expect(await desktop()).toBeNull()
    expect(isDesktop()).toBe(false)
  })

  it('treats an app that refuses the hello as absent', async () => {
    installApp(async () => { throw new Error('not allowed') })
    expect(await desktop()).toBeNull()
  })
})
