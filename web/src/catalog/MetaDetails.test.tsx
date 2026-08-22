import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MetaDetails } from './MetaDetails'
import { resolveStreams } from '../plugins/resolve'
import type { CatalogMeta } from './cinemeta'

vi.mock('./cinemeta', async () => {
  const actual = await vi.importActual<typeof import('./cinemeta')>('./cinemeta')
  // The whole shape: the component reads `detail.genres.length` and
  // `detail.cast.length` without optional chaining past the first dot, so a
  // partial detail takes the render down.
  return {
    ...actual,
    fetchMeta: vi.fn(async () => ({
      id: 'tt1', type: 'movie', name: 'Duna', poster: '', releaseInfo: '2021',
      background: '', logo: '', description: '', runtime: '', imdbRating: '',
      genres: [], cast: [], director: [], videos: [],
    })),
  }
})

vi.mock('../plugins/resolve', () => ({ resolveStreams: vi.fn() }))

const meta: CatalogMeta = { id: 'tt1', type: 'movie', name: 'Duna', poster: '', releaseInfo: '2021' }
const open = { meta }

const show = (mode: 'create' | 'host' | 'viewer') => render(
  <MetaDetails
    open={open}
    mode={mode}
    onClose={() => undefined}
    onPickStream={() => undefined}
    onOpenPlugins={() => undefined}
  />,
)

describe('MetaDetails and its empty states', () => {
  beforeEach(() => { vi.mocked(resolveStreams).mockReset() })

  it('does not run any plugin for a viewer', async () => {
    // A viewer never sees the source list — they see the button that asks the
    // host. Resolving anyway would build something the interface throws away
    // and would make a viewer need a plugin installed, which contradicts the
    // whole design.
    show('viewer')
    await screen.findByText('Duna')
    expect(resolveStreams).not.toHaveBeenCalled()
  })

  it('runs plugins for the person who will actually open the source', async () => {
    vi.mocked(resolveStreams).mockResolvedValue({ kind: 'streams', streams: [], failed: [] })
    show('create')
    await vi.waitFor(() => expect(resolveStreams).toHaveBeenCalled())
  })

  it('invites you to install when nothing is installed', async () => {
    vi.mocked(resolveStreams).mockResolvedValue({ kind: 'no-plugins' })
    show('create')
    expect(await screen.findByText(/nenhum plugin instalado/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /instalar um plugin/i })).toBeInTheDocument()
  })

  it('says the plugins found nothing, which is a different problem', async () => {
    vi.mocked(resolveStreams).mockResolvedValue({ kind: 'streams', streams: [], failed: [] })
    show('create')
    expect(await screen.findByText(/nenhum plugin conseguiu reproduzir/i)).toBeInTheDocument()
  })

  it('names the plugins that broke instead of telling you to install more', async () => {
    vi.mocked(resolveStreams).mockResolvedValue({ kind: 'streams', streams: [], failed: ['Torrentio'] })
    show('create')
    expect(await screen.findByText(/os plugins falharam/i)).toBeInTheDocument()
    expect(screen.getByText(/Torrentio/)).toBeInTheDocument()
    // Sending someone to install more plugins here is advice for a different
    // problem, so the invitation must not be on this one.
    expect(screen.queryByRole('button', { name: /instalar um plugin/i })).toBeNull()
  })
})
