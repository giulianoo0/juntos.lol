import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JLocalDownload, JLocalModal, JLocalStatus } from '../components/JLocal'
import { getJLocalSnapshot, resetJLocalForTests } from './status'

function stubHealth(body: unknown, ok = true): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: async () => body }))
}

describe('jlocal header', () => {
  beforeEach(() => {
    resetJLocalForTests()
    localStorage.clear()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('shows not-connected first, then connected once the app answers', async () => {
    stubHealth({ name: 'jlocal', version: 'v9.9.9' })
    render(<><JLocalStatus /><JLocalModal /></>)
    expect(screen.getByRole('button', { name: /não conectado|not connected/i })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /conectado|connected/i })).toBeInTheDocument()
    expect(getJLocalSnapshot()).toMatchObject({ connected: true, version: 'v9.9.9' })
  })

  it('stays down when nothing answers, without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refused')))
    render(<JLocalStatus />)
    await waitFor(() => expect(getJLocalSnapshot().connecting).toBe(false))
    expect(screen.getByRole('button', { name: /não conectado|not connected/i })).toBeInTheDocument()
  })

  it('opens the same onboarding modal from the status and the download button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refused')))
    render(<><JLocalStatus /><JLocalDownload /><JLocalModal /></>)
    fireEvent.click(await screen.findByRole('button', { name: /não conectado|not connected/i }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /conectar|connect to/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /fechar|close/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /baixar|download j local/i }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })
})
