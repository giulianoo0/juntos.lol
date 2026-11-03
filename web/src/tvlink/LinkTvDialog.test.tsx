import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../ui/Toast'
import { LinkTvDialog } from './LinkTvDialog'

const respond = (status: number, body?: unknown) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

type Call = { method: string; path: string; body: unknown }

function serve(answer: () => Promise<Response> = () => respond(200, { device: { id: 'tv1', name: 'TV da sala' } })) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path: input, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return answer()
  }))
  return calls
}

function renderDialog() {
  const onOpenChange = vi.fn()
  const onLinked = vi.fn()
  function Host() {
    const [open, setOpen] = useState(true)
    return <LinkTvDialog open={open} onOpenChange={(next) => { onOpenChange(next); setOpen(next) }} onLinked={onLinked} />
  }
  render(<ToastProvider><Host /></ToastProvider>)
  return { onOpenChange, onLinked }
}

describe('LinkTvDialog', () => {
  beforeEach(() => localStorage.setItem('ss.language', 'pt-BR'))
  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'mediaDevices')
  })

  it('formata o código enquanto digita e vincula a TV', async () => {
    const calls = serve()
    const { onOpenChange, onLinked } = renderDialog()
    const field = screen.getByRole('textbox', { name: 'Código da TV' })
    fireEvent.change(field, { target: { value: 'abcdefgh' } })
    expect(field).toHaveValue('ABCD-EFGH')
    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/tv/link', body: { code: 'ABCDEFGH' } }))
    expect(await screen.findByText('TV vinculada')).toBeInTheDocument()
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onLinked).toHaveBeenCalled()
  })

  it('diz no campo quando o código não existe', async () => {
    serve(() => respond(404, { error: 'code_not_found' }))
    const { onOpenChange } = renderDialog()
    fireEvent.change(screen.getByRole('textbox', { name: 'Código da TV' }), { target: { value: 'ABCD-EFGH' } })
    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Código não encontrado')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('vincula sozinho quando a câmera lê o QR da TV', async () => {
    const calls = serve()
    const stopTrack = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) },
    })
    vi.stubGlobal('BarcodeDetector', class {
      detect = vi.fn(async () => [{ rawValue: 'https://juntos.lol/tv/vincular?c=K7Q2-M9XA' }])
    })
    renderDialog()
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/tv/link', body: { code: 'K7Q2M9XA' } }))
    await waitFor(() => expect(stopTrack).toHaveBeenCalled())
  })
})
