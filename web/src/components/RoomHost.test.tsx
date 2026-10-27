import { act, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { RoomHost } from './RoomHost'

vi.mock('../pages/Room', () => ({
  RoomPage: ({ id, onInCall }: { id: string; onInCall: (inCall: boolean) => void }) => {
    useEffect(() => { onInCall(true) }, [onInCall])
    return <p>sala {id}</p>
  },
}))

let go: (to: string) => void = () => undefined
function Nav() {
  go = useNavigate()
  return null
}

describe('RoomHost', () => {
  it('keeps the call in the corner on another page and brings it back', async () => {
    render(<MemoryRouter initialEntries={['/room/abc']}><Nav /><RoomHost /></MemoryRouter>)
    expect(await screen.findByText('sala abc')).toBeInTheDocument()

    act(() => go('/c/7'))
    expect(screen.getByText('sala abc')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Voltar para a sala' }))
    expect(screen.queryByRole('button', { name: 'Voltar para a sala' })).toBeNull()
    expect(screen.getByText('sala abc')).toBeInTheDocument()
  })

  it('shows nothing outside a room', () => {
    render(<MemoryRouter initialEntries={['/']}><RoomHost /></MemoryRouter>)
    expect(screen.queryByText(/sala/)).toBeNull()
  })
})
