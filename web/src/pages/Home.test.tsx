import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Home } from './Home'

function RoomStub() {
  return <p>sala {useParams().id}</p>
}

function renderHome(createRoom = vi.fn().mockResolvedValue({ roomID: 'K7Q2M9XA' })) {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Home createRoom={createRoom} />} />
        <Route path="/room/:id" element={<RoomStub />} />
      </Routes>
    </MemoryRouter>,
  )
  return createRoom
}

describe('Home', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('ss.language', 'pt-BR')
  })

  it('creates a room with its name and goes into it', async () => {
    const createRoom = renderHome()
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome da sala' }), { target: { value: '  Sessão de sexta ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar sala' }))
    expect(createRoom).toHaveBeenCalledWith({ name: 'Sessão de sexta', password: '' })
    expect(await screen.findByText('sala K7Q2M9XA')).toBeInTheDocument()
  })

  it('asks for a password only after the lock is pressed', () => {
    const createRoom = renderHome()
    expect(screen.queryByLabelText('Senha', { selector: 'input' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Senha' }))
    expect(screen.getByRole('button', { name: 'Senha' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.change(screen.getByLabelText('Senha', { selector: 'input' }), { target: { value: 'pipoca' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar sala' }))
    expect(createRoom).toHaveBeenCalledWith({ name: '', password: 'pipoca' })
  })

  it('says when the room could not be created', async () => {
    renderHome(vi.fn().mockRejectedValue(new Error('nope')))
    fireEvent.click(screen.getByRole('button', { name: 'Criar sala' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Não deu para criar a sala')
  })

  it('enters a room by its code, or by a pasted link', async () => {
    renderHome()
    const code = screen.getByRole('textbox', { name: 'Código da sala' })
    const enter = screen.getByRole('button', { name: 'Entrar' })
    expect(enter).toBeDisabled()
    fireEvent.change(code, { target: { value: 'https://juntos.lol/room/k7q2m9xa' } })
    fireEvent.click(enter)
    expect(await screen.findByText('sala K7Q2M9XA')).toBeInTheDocument()
  })

  it('offers the Discord app in a new tab', () => {
    renderHome()
    const link = screen.getByRole('link', { name: 'Adicionar ao Discord' })
    expect(link).toHaveAttribute('href', 'https://discord.com/oauth2/authorize?client_id=1564358804206911529')
    expect(link).toHaveAttribute('target', '_blank')
  })
})
