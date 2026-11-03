import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as screenshare from '../screenshare'
import { TvRelayStage } from './TvRelayStage'

vi.mock('../screenshare', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../screenshare')>()),
  fetchScreenRelay: vi.fn(),
  watchScreen: vi.fn(),
}))

const signal = <T,>(value: T) => {
  let current = value
  const listeners = new Set<(next: T) => void>()
  return {
    peek: () => current,
    set: (next: T) => { current = next; for (const listener of listeners) listener(next) },
    subscribe: (listener: (next: T) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

let watchers: Array<{ path: string; volume: ReturnType<typeof signal<number>>; status: ReturnType<typeof signal<screenshare.ScreenWatchStatus>>; closed: boolean }>

beforeEach(() => {
  watchers = []
  vi.mocked(screenshare.fetchScreenRelay).mockResolvedValue({ url: 'https://relay.test', bridge: '/moq', base: 'juntos/R1', path: 'juntos/R1/tv1.hang', publish: false, open: false })
  vi.mocked(screenshare.watchScreen).mockImplementation(async (_relay, path, _canvas, _muted, _latency, volume = 1) => {
    const watcher = { path, volume: signal(volume), status: signal<screenshare.ScreenWatchStatus>('live'), closed: false }
    watchers.push(watcher)
    return {
      status: watcher.status, volume: watcher.volume, muted: signal(false), hasAudio: signal<boolean | undefined>(true),
      jump: () => undefined, close: () => { watcher.closed = true },
    } as unknown as screenshare.ScreenWatcher
  })
})

afterEach(() => vi.clearAllMocks())

describe('TvRelayStage', () => {
  it('assiste a tela de alguém pelo caminho dela, no volume do mix', async () => {
    const { rerender } = render(<TvRelayStage roomId="R1" memberId="tv1" capability="cap" source={{ kind: 'screen', ownerId: 'm2' }} title="Tela de Ana" volume={0.5} />)
    await waitFor(() => expect(watchers).toHaveLength(1))
    expect(watchers[0].path).toBe('juntos/R1/m2.hang')
    expect(watchers[0].volume.peek()).toBe(0.5)

    rerender(<TvRelayStage roomId="R1" memberId="tv1" capability="cap" source={{ kind: 'screen', ownerId: 'm2' }} title="Tela de Ana" volume={0} />)
    expect(watchers[0].volume.peek()).toBe(0)
    expect(watchers).toHaveLength(1)
  })

  it('assiste a live pelo broadcast dela', async () => {
    render(<TvRelayStage roomId="R1" memberId="tv1" capability="cap" source={{ kind: 'live', broadcast: 'juntos/R1/live.hang' }} title="Live" volume={1} />)
    await waitFor(() => expect(watchers[0]?.path).toBe('juntos/R1/live.hang'))
  })

  it('reabre a assinatura que o relay deixou sem imagem', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<TvRelayStage roomId="R1" memberId="tv1" capability="cap" source={{ kind: 'screen', ownerId: 'm2' }} title="Tela" volume={1} />)
      await waitFor(() => expect(watchers).toHaveLength(1))
      act(() => watchers[0].status.set('offline'))
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(watchers[0].closed).toBe(true)
      expect(watchers).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
