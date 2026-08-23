import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { helperAvailable, resetHelperAvailability } from './localHelper'

// Local Network Access is what makes this worth a test: the first request to
// 127.0.0.1 is what raises the browser's permission bubble, and the whole
// design is that only the user clicking "I already installed it" can do that.
// A probe that slips out from anywhere else asks a question the user has no
// context for, and an unexplained permission gets refused.
// jsdom serves the tests from localhost, where loopback is never gated; the
// gate only matters on the public site, so that is where these tests stand.
function stubPermission(state: PermissionState) {
  vi.stubGlobal('location', { ...location, hostname: 'ss.giuli.dev' })
  vi.stubGlobal('navigator', {
    ...navigator,
    permissions: { query: async () => ({ state, addEventListener() {}, removeEventListener() {} }) },
  })
}

describe('helper availability gate', () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetHelperAvailability()
  })

  it('does not reach the helper while the permission is still unasked', async () => {
    stubPermission('prompt')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { helperAvailable: gated } = await import('./localHelper')

    await expect(gated()).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not reach the helper once the permission is refused', async () => {
    stubPermission('denied')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { helperAvailable: gated } = await import('./localHelper')

    await expect(gated()).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('probes once the permission is granted', async () => {
    stubPermission('granted')
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ name: 'ss-bridge', version: '1.0.0' }) }))
    vi.stubGlobal('fetch', fetchMock)
    const { helperAvailable: gated } = await import('./localHelper')

    await expect(gated()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('probes in a browser that does not gate loopback at all', async () => {
    vi.stubGlobal('navigator', { ...navigator, permissions: undefined })
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ name: 'ss-bridge', version: '1.0.0' }) }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(helperAvailable()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalled()
  })
})
