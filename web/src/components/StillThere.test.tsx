import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StillThere } from './StillThere'

const t = ((key: string) => key) as never

describe('StillThere', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('counts down on the server clock and reports zero once, when nobody answered', () => {
    const onExpired = vi.fn()
    const onStay = vi.fn()
    const deadline = Date.now() + 2500
    render(<StillThere deadlineMs={deadline} serverOffsetMs={0} onStay={onStay} onExpired={onExpired} t={t} />)
    expect(screen.getByText('room.stillThereTitle')).toBeInTheDocument()
    expect(onExpired).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onExpired).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(onExpired).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(onExpired).toHaveBeenCalledTimes(1)
    expect(onStay).not.toHaveBeenCalled()
  })

  it('asks nothing while there is no deadline', () => {
    const onExpired = vi.fn()
    render(<StillThere deadlineMs={null} serverOffsetMs={0} onStay={() => undefined} onExpired={onExpired} t={t} />)
    expect(screen.queryByText('room.stillThereTitle')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(onExpired).not.toHaveBeenCalled()
  })
})
