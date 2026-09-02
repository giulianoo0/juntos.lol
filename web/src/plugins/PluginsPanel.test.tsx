import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginsPanel } from './PluginsPanel'
import { deletePlugin, listPlugins, putPlugin, type InstalledPlugin } from './store'

vi.mock('./install', async () => {
  const actual = await vi.importActual<typeof import('./install')>('./install')
  return {
    ...actual,
    readManifestFromSource: vi.fn(async () => ({
      id: 'acme', name: 'Acme', version: '1.0.0', hosts: ['streams.example.com'], updateUrl: null,
    })),
    fetchGitPlugin: vi.fn(async () => ({ source: 'export const manifest = {}', commit: 'abc' })),
  }
})

const show = () => render(<PluginsPanel open onClose={() => undefined} />)

const existing: InstalledPlugin = {
  id: 'mirrors',
  manifest: { id: 'mirrors', name: 'Mirrors', version: '2.1.0', hosts: ['cdn.example.com'], updateUrl: null },
  source: '', sha256: 'a'.repeat(64),
  origin: { kind: 'file', fileName: 'mirrors.js', updateUrl: null },
  approvedHosts: ['cdn.example.com'], enabled: true, pendingUpdate: null, installedAt: 1,
}

describe('PluginsPanel', () => {
  beforeEach(async () => {
    for (const plugin of await listPlugins()) await deletePlugin(plugin.id)
  })

  it('invites you to add one when the list is empty', async () => {
    show()
    expect(await screen.findByText(/nenhum plugin instalado/i)).toBeInTheDocument()
  })

  it('lists an installed plugin with its version and where it came from', async () => {
    await putPlugin(existing)
    show()
    expect(await screen.findByText('Mirrors')).toBeInTheDocument()
    expect(screen.getByText(/2\.1\.0/)).toBeInTheDocument()
    expect(screen.getByText(/mirrors\.js/)).toBeInTheDocument()
  })

  it('shows the hosts a candidate wants before anything is stored', async () => {
    show()
    await userEvent.click(await screen.findByRole('button', { name: /adicionar/i }))
    await userEvent.type(await screen.findByLabelText(/endereço do repositório/i), 'https://github.com/u/r')
    await userEvent.click(screen.getByRole('button', { name: /buscar/i }))
    expect(await screen.findByText('streams.example.com')).toBeInTheDocument()
    expect(await listPlugins()).toHaveLength(0)
  })

  it('stores the plugin only after the confirmation', async () => {
    show()
    await userEvent.click(await screen.findByRole('button', { name: /adicionar/i }))
    await userEvent.type(await screen.findByLabelText(/endereço do repositório/i), 'https://github.com/u/r')
    await userEvent.click(screen.getByRole('button', { name: /buscar/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^instalar$/i }))
    await waitFor(async () => expect(await listPlugins()).toHaveLength(1))
  })

  it('says what an install would replace instead of overwriting in silence', async () => {
    const { originId } = await import('./store')
    await putPlugin({ ...existing, id: await originId({ kind: 'file', fileName: 'plugin.js', updateUrl: null }) })
    show()
    await userEvent.click(await screen.findByRole('button', { name: /adicionar/i }))
    await screen.findByLabelText(/endereço do repositório/i)
    const input = document.querySelector('input[type="file"]')
    if (!input) throw new Error('no file input')
    const file = new File(['export const manifest = {}'], 'plugin.js', { type: 'text/javascript' })
    await userEvent.upload(input as HTMLInputElement, file)
    expect(await screen.findByText(/isto substitui o plugin instalado/i)).toBeInTheDocument()
    expect(screen.getByText(/Mirrors 2\.1\.0/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^substituir$/i })).toBeInTheDocument()
  })

  it('removes a plugin', async () => {
    await putPlugin(existing)
    show()
    await userEvent.click(await screen.findByRole('button', { name: /remover mirrors/i }))
    await waitFor(async () => expect(await listPlugins()).toHaveLength(0))
  })

  it('switches a plugin off without removing it', async () => {
    await putPlugin(existing)
    show()
    await userEvent.click(await screen.findByRole('checkbox', { name: /ativar mirrors/i }))
    await waitFor(async () => expect((await listPlugins())[0]?.enabled).toBe(false))
  })

  it('offers to update everything only when something has somewhere to update from', async () => {
    await putPlugin(existing)
    const { unmount } = show()
    expect(await screen.findByText('Mirrors')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /atualizar todos/i })).toBeNull()
    unmount()

    await putPlugin({ ...existing, id: 'repo', origin: { kind: 'git', updateUrl: 'https://github.com/u/r', commit: 'a' } })
    show()
    expect(await screen.findByRole('button', { name: /atualizar todos/i })).toBeInTheDocument()
  })

  it('names the new hosts of a held update', async () => {
    await putPlugin({
      ...existing,
      pendingUpdate: {
        source: '', sha256: 'b'.repeat(64),
        manifest: { ...existing.manifest, version: '3.0.0', hosts: ['cdn.example.com', 'tracker.new.com'] },
        commit: 'ccc', newHosts: ['tracker.new.com'],
      },
    })
    show()
    expect(await screen.findByText(/tracker\.new\.com/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /aprovar/i })).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(<PluginsPanel open onClose={onClose} />)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('renders nothing at all when closed', () => {
    const { container } = render(<PluginsPanel open={false} onClose={() => undefined} />)
    expect(container).toBeEmptyDOMElement()
  })
})
