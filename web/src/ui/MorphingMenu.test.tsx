import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MorphingMenu } from './MorphingMenu'

describe('MorphingMenu (on the spring popover)', () => {
  it('opens on a click, tells the caller, and closes from inside', async () => {
    const onOpen = vi.fn()
    render(
      <MorphingMenu haspopup="menu" ariaLabel="Qualidade" onOpen={onOpen} trigger={() => 'Auto'}>
        {(close) => <button type="button" onClick={() => close()}>1080p</button>}
      </MorphingMenu>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Qualidade' }))
    expect(onOpen).toHaveBeenCalledOnce()
    fireEvent.click(await screen.findByRole('button', { name: '1080p' }))
    expect(screen.getByRole('button', { name: 'Qualidade' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens on a right click when asked to, and not on a plain click', async () => {
    render(
      <MorphingMenu haspopup="menu" ariaLabel="Ana" openOn="contextmenu" trigger={() => 'Ana'}>
        {() => <button type="button">Expulsar</button>}
      </MorphingMenu>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ana' }))
    expect(screen.queryByRole('button', { name: 'Expulsar' })).toBeNull()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Ana' }))
    expect(await screen.findByRole('button', { name: 'Expulsar' })).toBeInTheDocument()
  })
})
