import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomPage } from './Room'

class FakeWebSocket {
  static OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  send = vi.fn()
  close = vi.fn()
}

function renderRoom() {
  return render(
    <MemoryRouter initialEntries={['/room/abc123']}>
      <Routes><Route path="/room/:id" element={<RoomPage />} /></Routes>
    </MemoryRouter>,
  )
}

describe('RoomPage join screen', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'abc123',
        fileName: 'movie.mkv',
        status: 'uploading',
        controllerId: 'm1',
        audioTracks: null,
        subtitleTracks: null,
        bitmapSubsSkipped: 0,
        memberCount: 1,
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('asks for a name and nothing else when the room is opened from a link', async () => {
    renderRoom()

    // The link already grants access, so the only prompt is the display name.
    const field = await screen.findByLabelText(/your name|seu nome/i)
    expect(field).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /what should we call you|como devemos chamar você/i })).toBeInTheDocument()
    expect(document.querySelectorAll('input')).toHaveLength(1)
  })

  it('joins with the typed name when the field is submitted', async () => {
    renderRoom()

    const field = await screen.findByLabelText(/your name|seu nome/i)
    fireEvent.change(field, { target: { value: '  Giuli  ' } })
    fireEvent.submit(field.closest('form')!)

    await waitFor(() => expect(localStorage.getItem('ss.nickname')).toBe('Giuli'))
    expect(screen.queryByRole('heading', { name: /what should we call you|como devemos chamar você/i })).not.toBeInTheDocument()
  })

  it('accepts an empty name and falls back to a generated guest name', async () => {
    renderRoom()

    const field = await screen.findByLabelText(/your name|seu nome/i)
    fireEvent.submit(field.closest('form')!)

    await waitFor(() => expect(localStorage.getItem('ss.nickname')).toMatch(/^Guest-[A-Za-z0-9]{6}$/))
  })

  it('skips the prompt entirely for someone who already has a name', async () => {
    localStorage.setItem('ss.nickname', 'Giuli')
    renderRoom()

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByLabelText(/your name|seu nome/i)).not.toBeInTheDocument()
  })
})
