import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FleetStatus } from './FleetStatus'

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: 'w_aaaaaaaa1111',
    availability: 'available',
    load: 0.1,
    leases: 1,
    maxLeases: 8,
    torrents: 1,
    maxTorrents: 10,
    diskUsed: 10_737_418_240,
    diskQuota: 107_374_182_400,
    transferUsedBps: 1_000_000,
    transferCapBps: 100_000_000,
    lastSeenSecs: 2,
    ...overrides,
  }
}

function answer(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }))
}

describe('FleetStatus', () => {
  beforeEach(() => {
    localStorage.setItem('ss.language', 'en')
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('draws the shape of the answer while it is still being fetched', async () => {
    let release: (value: unknown) => void = () => {}
    const pending = new Promise((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending))
    const { container } = render(<FleetStatus />)

    // Same header, same bar, same row of facts, so nothing jumps when the
    // numbers land.
    expect(container.querySelectorAll('.fleet-card.is-skeleton')).toHaveLength(2)
    expect(container.querySelector('.fleet-meter-track')).not.toBeNull()
    // The bones are decoration; the announcement is the sentence behind them.
    expect(screen.getByText('Reading the fleet…')).toHaveClass('sr-only')

    release({ ok: true, json: async () => ({ capacity: 'available', workers: [member()] }) })
    await waitFor(() => expect(screen.getByText('aaaaaaaa')).toBeInTheDocument())
    expect(container.querySelector('.fleet-card.is-skeleton')).toBeNull()
  })

  it('replaces the skeleton with the failure rather than waiting forever', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { container } = render(<FleetStatus />)

    await waitFor(() => expect(screen.getByText('The fleet did not answer')).toBeInTheDocument())
    expect(container.querySelector('.fleet-card.is-skeleton')).toBeNull()
  })

  it('keeps the order the server sent, because it is the order rooms are placed in', async () => {
    answer({
      capacity: 'available',
      workers: [
        member({ id: 'w_first0000', leases: 0 }),
        member({ id: 'w_second000', leases: 6 }),
        member({ id: 'w_third0000', availability: 'busy', leases: 8 }),
      ],
    })
    render(<FleetStatus />)

    await waitFor(() => expect(screen.getByText('first000')).toBeInTheDocument())
    const rendered = screen.getAllByRole('listitem').map((item) => item.querySelector('code')?.textContent)
    expect(rendered).toEqual(['first000', 'second00', 'third000'])
    // Only the head of the list, and only when there is a choice to make.
    expect(screen.getAllByText('Best')).toHaveLength(1)
  })

  it('measures busyness by whichever budget is closest to refusing the next room', async () => {
    // Leases and disk are nearly empty; the pipe is not. An average would
    // call this quiet, and the next room would be refused anyway.
    answer({
      capacity: 'available',
      workers: [member({ leases: 1, maxLeases: 8, diskUsed: 1, diskQuota: 100, transferUsedBps: 80, transferCapBps: 100 })],
    })
    render(<FleetStatus />)

    await waitFor(() => expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '80'))
  })

  it('says a deployment runs no workers rather than showing an empty list', async () => {
    answer({ capacity: 'disabled', workers: [] })
    render(<FleetStatus />)

    await waitFor(() => expect(screen.getByText('This deployment runs no workers.')).toBeInTheDocument())
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('keeps the last good reading on screen when a poll fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ capacity: 'available', workers: [member()] }) })
      .mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    render(<FleetStatus />)
    await waitFor(() => expect(screen.getByText('aaaaaaaa')).toBeInTheDocument())

    await vi.advanceTimersByTimeAsync(10_000)

    // A blip in the poll is not news about the fleet: blanking the page
    // would say it was.
    await waitFor(() => expect(screen.getByText(/has not answered since/)).toBeInTheDocument())
    expect(screen.getByText('aaaaaaaa')).toBeInTheDocument()
  })
})
