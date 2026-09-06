import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JLocalScreenModal } from '../components/JLocalScreen'
import {
  getCachedJLocalCapabilities,
  isJLocalCaptureAvailable,
  refreshJLocalCapabilities,
  resetJLocalCapabilitiesForTests,
} from './capabilities'
import { connectJLocal, getJLocalSnapshot, resetJLocalForTests } from './status'

const CONTRACT_CAPS = {
  name: 'jlocal',
  version: 'v0.0.1',
  capabilities: {
    screen: { available: true, maxWidth: 3840, maxHeight: 2160, maxFps: 60 },
    audio: { appList: false },
    torrent: { available: false },
  },
}

/** Routes /health to the status probe and /capabilities to the caps fetch. */
function stubFetch(health: unknown, caps: unknown, capsOk = true): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (String(url).endsWith('/capabilities')) {
      return { ok: capsOk, status: capsOk ? 200 : 501, json: async () => caps }
    }
    return { ok: true, json: async () => health }
  }))
}

describe('jlocal capture gate', () => {
  beforeEach(() => {
    resetJLocalForTests()
    resetJLocalCapabilitiesForTests()
    localStorage.clear()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('returns false while the app is disconnected', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refused')))
    expect(getJLocalSnapshot().connected).toBe(false)
    expect(isJLocalCaptureAvailable()).toBe(false)
  })

  it('returns false when connected but caps are missing or stale', async () => {
    stubFetch({ name: 'jlocal', version: 'v0.0.1' }, { error: 'not_implemented' }, false)
    connectJLocal()
    await waitFor(() => expect(getJLocalSnapshot().connected).toBe(true))
    // The room-JSON-shaped payload parses to null, so the gate stays shut.
    expect(getCachedJLocalCapabilities()).toBeNull()
    expect(isJLocalCaptureAvailable()).toBe(false)

    stubFetch({ name: 'jlocal', version: 'v0.0.1' }, CONTRACT_CAPS)
    refreshJLocalCapabilities()
    await waitFor(() => expect(isJLocalCaptureAvailable()).toBe(true))

    const travel = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    try {
      expect(isJLocalCaptureAvailable()).toBe(false)
    } finally {
      travel.mockRestore()
    }
  })

  it('returns true when connected with cached caps advertising screen', async () => {
    stubFetch({ name: 'jlocal', version: 'v0.0.1' }, CONTRACT_CAPS)
    connectJLocal()
    await waitFor(() => expect(getJLocalSnapshot().connected).toBe(true))
    expect(isJLocalCaptureAvailable()).toBe(false)
    refreshJLocalCapabilities()
    await waitFor(() => expect(getCachedJLocalCapabilities()).not.toBeNull())
    expect(isJLocalCaptureAvailable()).toBe(true)
  })
})

describe('jlocal screen modal', () => {
  beforeEach(() => {
    resetJLocalForTests()
    resetJLocalCapabilitiesForTests()
    localStorage.clear()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('renders the title and calls onUseBrowser on click', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refused')))
    const onUseBrowser = vi.fn()
    render(<JLocalScreenModal open onOpenChange={() => undefined} onUseBrowser={onUseBrowser} />)
    expect(screen.getByText(/qualidade máxima|full quality/i)).toBeInTheDocument()
    const fallback = screen.getByRole('button', { name: /navegador|browser/i })
    fireEvent.click(fallback)
    expect(onUseBrowser).toHaveBeenCalledTimes(1)
  })

  it('shows the update hint when the app answers 501', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 501, json: async () => ({ error: 'not_implemented' }) })))
    render(<JLocalScreenModal open onOpenChange={() => undefined} onUseBrowser={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: /j local/i }))
    expect(await screen.findByText(/mais novo|newer/i)).toBeInTheDocument()
  })
})
