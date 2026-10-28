import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataPage } from './Data'
import type { DataReport } from './data/report'

const report: DataReport = {
  generatedAt: '2026-10-28T12:00:00Z',
  now: { rooms: 3, members: 7, roomsByState: { ready: 2, empty: 1 } },
  fleet: { online: 1, total: 2, torrents: 4, leases: 1, diskUsed: 0, diskQuota: 0, transferUsedBps: 0, transferCapBps: 0 },
  accounts: { total: 12, public: 5, signedIn: 6, friendships: 2, watches: 9, watchedSeconds: 7200, watchesByKind: { torrent: 6, youtube: 3 }, newByDay: {} },
  days: [
    { day: '2026-10-27', metrics: { visitors: 40, rooms_created: 4 } },
    { day: '2026-10-28', metrics: { visitors: 20, rooms_created: 1 } },
  ],
}

function serve(answer: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn((input: string) => input === '/api/data' ? answer() : Promise.resolve(new Response('{}', { status: 401 }))))
}

function renderPage() {
  render(<MemoryRouter initialEntries={['/data']}><DataPage /></MemoryRouter>)
}

afterEach(() => vi.unstubAllGlobals())

describe('DataPage', () => {
  it('mostra o agora, as contas e o número do período de cada gráfico', async () => {
    serve(() => Promise.resolve(Response.json(report)))
    renderPage()
    expect(await screen.findByText('Pessoas em salas', { selector: 'dt' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Visitantes únicos: 30' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Salas criadas: 5' })).toBeInTheDocument()
    expect(screen.getByText('Horas assistidas').nextSibling).toHaveTextContent('2')
  })

  it('a seta mostra o valor do dia no lugar do período', async () => {
    serve(() => Promise.resolve(Response.json(report)))
    renderPage()
    const plot = await screen.findByRole('img', { name: 'Salas criadas: 5' })
    fireEvent.keyDown(plot, { key: 'ArrowLeft' })
    expect(plot.parentElement).toHaveTextContent('4')
    expect(plot.parentElement).toHaveTextContent('27 de out.')
  })

  it('carga que falhou oferece tentar de novo', async () => {
    serve(() => Promise.resolve(new Response('', { status: 500 })))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Não deu para carregar os dados.')
    serve(() => Promise.resolve(Response.json(report)))
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    expect(await screen.findByRole('img', { name: 'Salas criadas: 5' })).toBeInTheDocument()
  })
})
