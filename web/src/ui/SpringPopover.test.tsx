import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SpringPopover, SpringRow } from './SpringPopover'

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

  it('a locked row says why in its name', () => {
    render(<SpringRow label="YouTube" locked="Exclusivo do app" onSelect={() => {}} />)
    expect(screen.getByRole('menuitem', { name: 'YouTube, exclusivo do app' })).toBeInTheDocument()
  })
})
