import { afterEach, describe, expect, it, vi } from 'vitest'
import { UNSAFE_createBrowserHistory as createBrowserHistory } from 'react-router-dom'
import { deferPops, type History } from './backForward'

describe('deferPops', () => {
  afterEach(() => vi.useRealTimers())

  it('hands back and forward to the router after the popstate event, so React keeps them as transitions', async () => {
    const history = deferPops(createBrowserHistory({ v5Compat: true }))
    const seen: Array<{ action: string; path: string; during: string | undefined }> = []
    const stop = history.listen((update: Parameters<Parameters<History['listen']>[0]>[0]) => seen.push({ action: update.action, path: update.location.pathname, during: window.event?.type }))

    history.push('/c/1')
    expect(seen).toEqual([{ action: 'PUSH', path: '/c/1', during: undefined }])

    window.history.back()
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1]).toEqual({ action: 'POP', path: '/', during: undefined })
    stop()
  })

  it('still reads where it is and navigates like the history it wraps', () => {
    const history = deferPops(createBrowserHistory({ v5Compat: true }))
    history.push('/data')
    expect(history.location.pathname).toBe('/data')
    expect(history.action).toBe('PUSH')
    expect(history.createHref({ pathname: '/c/5' })).toBe('/c/5')
  })
})
