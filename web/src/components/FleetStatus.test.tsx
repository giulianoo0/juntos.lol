import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FleetStatus } from './FleetStatus'
import { probeWorkers } from '../remoteTorrent'

vi.mock('../remoteTorrent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../remoteTorrent')>()),
  probeWorkers: vi.fn(),
}))

/** Measuring is the page's other source; most tests do not exercise it. */
function measures(results: Array<{ id: string; mbit?: number; state?: 'ok' | 'down' }> = []) {
  vi.mocked(probeWorkers).mockImplementation(async () => results.map((r) => ({
    id: r.id, readBase: '', holds: false, state: r.state ?? 'ok', mbit: r.mbit,
  })))
}

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
    measures()
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

  it('ranks by the speed it measured from this browser, not by how idle a worker is', async () => {
    // The least loaded worker in the fleet can be the worst place for this
    // viewer: a dispatch carries the page's own ranking, and the server takes
    // the first of those that has room.
    answer({
      capacity: 'available',
      workers: [
        member({ id: 'w_idle00000', leases: 0 }),
        member({ id: 'w_loaded000', leases: 6 }),
      ],
    })
    measures([{ id: 'w_idle00000', mbit: 4 }, { id: 'w_loaded000', mbit: 90 }])
    render(<FleetStatus />)

    await waitFor(() => expect(screen.getByText('90 Mbit/s')).toBeInTheDocument())
    await waitFor(() => {
      const order = screen.getAllByRole('listitem').map((item) => item.querySelector('code')?.textContent)
      expect(order).toEqual(['loaded00', 'idle0000'])
    })
    const best = screen.getByText('Best').closest('li')
    expect(best?.querySelector('code')?.textContent).toBe('loaded00')
  })

  it('keeps a worker that cannot take work below one that can, however fast it is', async () => {
    answer({
      capacity: 'available',
      workers: [member({ id: 'w_full00000', availability: 'busy' }), member({ id: 'w_free00000' })],
    })
    measures([{ id: 'w_full00000', mbit: 900 }, { id: 'w_free00000', mbit: 10 }])
    render(<FleetStatus />)

    await waitFor(() => expect(screen.getByText('10 Mbit/s')).toBeInTheDocument())
    const order = screen.getAllByRole('listitem').map((item) => item.querySelector('code')?.textContent)
    expect(order).toEqual(['free0000', 'full0000'])
  })

  it('claims no best until it has measured one', async () => {
    answer({ capacity: 'available', workers: [member({ id: 'w_one000000' }), member({ id: 'w_two000000' })] })
    // Nothing measurable: a badge here would be a guess wearing a label.
    measures([{ id: 'w_one000000', state: 'down' }, { id: 'w_two000000', state: 'down' }])
    render(<FleetStatus />)

    await waitFor(() => expect(screen.getAllByText('no route from here')).toHaveLength(2))
    expect(screen.queryByText('Best')).not.toBeInTheDocument()
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

  it('keeps every field in every card, so two workers can be read against each other', async () => {
    // One worker reports a bandwidth ceiling and the other does not. Dropping
    // the field shifted every later field left, and the gap looked like a
    // fault rather than an unset setting.
    answer({
      capacity: 'available',
      workers: [member({ id: 'w_capped000' }), member({ id: 'w_uncapped0', transferCapBps: undefined })],
    })
    render(<FleetStatus />)

    await waitFor(() => expect(screen.getAllByText('Serving')).toHaveLength(2))
    const cards = screen.getAllByRole('listitem')
    const labels = cards.map((card) => [...card.querySelectorAll('dt')].map((dt) => dt.textContent))
    expect(labels[0]).toEqual(labels[1])
    expect(screen.getByText('no ceiling')).toBeInTheDocument()
  })

  it('reads bandwidth in bytes per second, which is what the worker reports', async () => {
    // capBps is the worker's ceiling in BYTES; a megabit is 125_000 of them.
    // Dividing by a million printed a 600 Mbit/s pipe as 75.
    answer({ capacity: 'available', workers: [member({ transferCapBps: 75_000_000, transferUsedBps: 1_250_000 })] })
    render(<FleetStatus />)

    await waitFor(() => expect(screen.getByText('10.0 Mbit/s / 600.0 Mbit/s')).toBeInTheDocument())
  })

  it('shimmers the speed while it is still being measured', async () => {
    answer({ capacity: 'available', workers: [member()] })
    vi.mocked(probeWorkers).mockImplementation(() => new Promise(() => {}))
    const { container } = render(<FleetStatus />)

    await waitFor(() => expect(screen.getByText('measuring…')).toBeInTheDocument())
    expect(container.querySelector('dd.is-pending')?.textContent).toBe('measuring…')
  })

  // The status page's one live number: counted from the open sockets, so it
  // has its own endpoint and its own faster clock.
  it('shows how many rooms and people are on right now', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: async () => url === '/api/live'
        ? { rooms: 3, members: 7 }
        : { capacity: 'available', workers: [member()] },
    })))
    render(<FleetStatus />)

    await waitFor(() => expect(screen.getByText('Rooms open')).toBeInTheDocument())
    expect(screen.getByText('People watching')).toBeInTheDocument()
    // NumberFlow animates towards the value and keeps the digits it is given
    // in the accessible text, so the count is asserted through that.
    const counts = document.querySelectorAll('.fleet-live dd')
    expect(counts[0].textContent).toContain('3')
    expect(counts[1].textContent).toContain('7')
  })

  // The worker holds a window, not the file: reporting the reservation said a
  // 100 GB quota was a tenth full when the volume held a few hundred MB.
  it('reports the disk a worker is really holding, not what it reserved', async () => {
    answer({ capacity: 'available', workers: [member({ diskUsed: 10_737_418_240, diskReal: 343_932_928 })] })
    render(<FleetStatus />)

    await waitFor(() => expect(screen.getByText('0.3 GB / 100.0 GB')).toBeInTheDocument())
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
