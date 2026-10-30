import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetDesktopForTests } from '../platform'
import { AppUpdate } from './AppUpdate'

const hello = { protocolVersion: 1, version: '0.1.0', compatible: true, mediaRoot: 'juntos-media://localhost' }

function installApp(status: unknown, helloAnswer: unknown = hello) {
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'app_hello') return helloAnswer
    if (cmd === 'update_status') return status
    return null
  })
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
  resetDesktopForTests()
  return invoke
}

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  resetDesktopForTests()
})

describe('AppUpdate', () => {
  it('says nothing in a browser', () => {
    const { container } = render(<AppUpdate />)
    expect(container.innerHTML).toBe('')
  })

  it('says nothing while the app is current', async () => {
    const invoke = installApp({ state: 'idle' })
    const { container } = render(<AppUpdate />)
    await act(async () => {})
    expect(invoke).toHaveBeenCalledWith('update_status')
    expect(container.querySelector('button')).toBeNull()
  })

  it('offers a restart once the new version is downloaded, and restarts only when asked', async () => {
    const invoke = installApp({ state: 'ready', version: '0.1.1' })
    render(<AppUpdate />)
    const restart = await screen.findByRole('button', { name: 'Reiniciar' })
    expect(invoke).not.toHaveBeenCalledWith('update_restart')
    fireEvent.click(restart)
    expect(invoke).toHaveBeenCalledWith('update_restart')
  })

  it('an install that fails stops offering a restart that does nothing', async () => {
    const invoke = installApp({ state: 'ready', version: '0.2.2' })
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'app_hello') return hello
      if (cmd === 'update_status') return { state: 'ready', version: '0.2.2' }
      if (cmd === 'update_restart') throw new Error('install: read-only volume')
      return null
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<AppUpdate />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reiniciar' }))

    expect(await screen.findByText('Não deu para atualizar')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reiniciar' })).toBeNull()
  })

  it('an app too old for the site gets the update screen and fetches the update at once', async () => {
    const invoke = installApp({ state: 'downloading', version: '0.2.0', received: 50, total: 100 }, { ...hello, compatible: false, updateRequired: true })
    render(<AppUpdate />)
    expect(await screen.findByRole('heading', { name: 'Atualize o app' })).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith('update_now')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
  })
})
