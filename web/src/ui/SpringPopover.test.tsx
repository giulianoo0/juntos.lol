import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpringPopover, SpringRow } from './SpringPopover'
import { useSpringPresence } from './springPresence'

function Presence({ open }: { open: boolean }) {
  const presence = useSpringPresence<HTMLDivElement>(open)
  return presence.present ? <div data-testid="popup" ref={presence.ref} {...presence.props} /> : null
}

describe('useSpringPresence', () => {
  afterEach(() => { vi.useRealTimers() })

  it('mounts the popup when it opens, without the closing mark', () => {
    const { rerender } = render(<Presence open={false} />)
    expect(screen.queryByTestId('popup')).toBeNull()
    rerender(<Presence open />)
    expect(screen.getByTestId('popup')).not.toHaveAttribute('data-ending-style')
  })

  it('keeps the popup inert and marked while it settles back', () => {
    const { rerender } = render(<Presence open />)
    rerender(<Presence open={false} />)
    const popup = screen.getByTestId('popup')
    expect(popup).toHaveAttribute('data-ending-style')
    expect(popup).toHaveAttribute('inert')
  })

  it('unmounts once the settle ends', () => {
    const { rerender } = render(<Presence open />)
    rerender(<Presence open={false} />)
    const popup = screen.getByTestId('popup')
    const end = new Event('transitionend', { bubbles: true }) as Event & { propertyName: string }
    Object.defineProperty(end, 'propertyName', { value: 'scale' })
    act(() => { popup.dispatchEvent(end) })
    expect(screen.queryByTestId('popup')).toBeNull()
  })

  it('unmounts on its own when the settle never reports an end', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Presence open />)
    rerender(<Presence open={false} />)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.queryByTestId('popup')).toBeNull()
  })
})

describe('SpringPopover', () => {
  it('opens its rows from the trigger and closes on a pick', async () => {
    const onPick = vi.fn()
    render(
      <SpringPopover trigger="Compartilhar" title="Abrir um palco">
        {({ close }) => <SpringRow label="Tela" onSelect={() => { onPick(); close() }} />}
      </SpringPopover>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }))
    const row = await screen.findByRole('menuitem', { name: 'Tela' })
    fireEvent.click(row)
    expect(onPick).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Compartilhar' })).toHaveAttribute('aria-expanded', 'false')
  })
})
