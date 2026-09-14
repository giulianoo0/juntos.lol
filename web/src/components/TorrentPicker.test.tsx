import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { translate, type Translator } from '../i18n/useT'
import { TorrentPicker } from './TorrentPicker'

vi.mock('../torrent', () => ({ openTorrent: vi.fn() }))
vi.mock('../remoteTorrent', () => ({ torrentCapacity: vi.fn(async () => 'available') }))

const { openTorrent } = await import('../torrent')

const t = Object.assign((key: string) => translate('pt-BR', key), {
  language: 'pt-BR' as const,
  setLanguage: vi.fn(),
}) as Translator

const session = () => ({
  name: 'Serie',
  magnet: 'magnet:?xt=urn:btih:abc',
  files: [
    { name: 'Ep 1.mkv', path: 'Serie/Ep 1.mkv', index: 0, size: 100, type: 'video/x-matroska', progress: 0, downloaded: 0 },
    { name: 'Ep 2.mkv', path: 'Serie/Ep 2.mkv', index: 1, size: 100, type: 'video/x-matroska', progress: 0, downloaded: 0 },
  ],
  subtitleFiles: [],
  stats: () => ({ peers: 0, downloadSpeed: 0, downloaded: 0, progress: 0 }),
  select: vi.fn(async () => undefined),
  destroy: vi.fn(),
})

afterEach(() => vi.clearAllMocks())

describe('TorrentPicker playlist', () => {
  it('opens straight on the files of the magnet it was given, marking the one playing', async () => {
    vi.mocked(openTorrent).mockResolvedValue(session() as never)
    render(
      <TorrentPicker
        maxFileBytes={1e12} t={t} onPicked={vi.fn()} onExit={vi.fn()}
        initialMagnet="magnet:?xt=urn:btih:abc" autoLoad currentPath="Serie/Ep 1.mkv"
      />,
    )
    expect(await screen.findByRole('button', { name: /Ep 2\.mkv/ })).toBeInTheDocument()
    expect(openTorrent).toHaveBeenCalledWith('magnet:?xt=urn:btih:abc', expect.any(Function), expect.anything())
    expect(screen.getByRole('button', { name: /Ep 1\.mkv/ })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: /Ep 2\.mkv/ })).not.toHaveAttribute('aria-current')
    expect(screen.queryByLabelText(/Link magnet|Magnet/i)).not.toBeInTheDocument()
  })

  it('offers a fixed way back to the magnet field, prefilled with the current link', async () => {
    const opened = session()
    vi.mocked(openTorrent).mockResolvedValue(opened as never)
    render(
      <TorrentPicker maxFileBytes={1e12} t={t} onPicked={vi.fn()} onExit={vi.fn()} initialMagnet="magnet:?xt=urn:btih:abc" autoLoad />,
    )
    await screen.findByRole('button', { name: /Ep 1\.mkv/ })
    fireEvent.click(screen.getByRole('button', { name: 'Trocar magnet' }))
    expect(opened.destroy).toHaveBeenCalledOnce()
    expect(await screen.findByRole('textbox', { name: /magnet/i })).toHaveValue('magnet:?xt=urn:btih:abc')
    expect(screen.queryByRole('button', { name: 'Trocar magnet' })).not.toBeInTheDocument()
  })

  it('picks another file from the list and hands the session over', async () => {
    const opened = session()
    vi.mocked(openTorrent).mockResolvedValue(opened as never)
    const onPicked = vi.fn()
    render(
      <TorrentPicker maxFileBytes={1e12} t={t} onPicked={onPicked} initialMagnet="magnet:?xt=urn:btih:abc" autoLoad currentPath="Serie/Ep 1.mkv" />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /Ep 2\.mkv/ }))
    await vi.waitFor(() => expect(onPicked).toHaveBeenCalledWith(opened.files[1], opened, 'magnet:?xt=urn:btih:abc'))
    expect(opened.select).toHaveBeenCalledWith('Serie/Ep 2.mkv')
  })
})
