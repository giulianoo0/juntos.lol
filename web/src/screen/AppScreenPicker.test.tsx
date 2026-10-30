import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translate, type Translator } from '../i18n/useT'
import { getSoundChoice, resetSoundChoiceForTests } from '../jlocal/soundChoice'
import { appAudioApps, appThumbnail } from '../desktop/screen'
import { AppScreenPicker } from './AppScreenPicker'

const DISCORD_ICON = 'data:image/png;base64,ZGlzY29yZA=='
const CHROME_ICON = 'data:image/png;base64,Y2hyb21l'

vi.mock('../desktop/screen', () => ({
  appSources: vi.fn(async () => ({
    displays: [{ id: 'd1', name: 'Tela 1', width: 2560, height: 1440 }],
    windows: [{ id: 'w1', title: 'YouTube', app: 'Google Chrome', icon: CHROME_ICON }],
  })),
  appThumbnail: vi.fn(async () => 'data:image/jpeg;base64,dGh1bWI='),
  appAudioApps: vi.fn(async () => [
    { id: 'chrome', name: 'Google Chrome', icon: CHROME_ICON },
    { id: 'discord', name: 'Discord', icon: DISCORD_ICON },
    { id: 'system', name: 'Sons do sistema', icon: '' },
  ]),
}))

const t = Object.assign((key: string) => translate('pt-BR', key), {
  language: 'pt-BR' as const,
  setLanguage: vi.fn(),
}) as Translator

beforeEach(() => {
  vi.clearAllMocks()
  resetSoundChoiceForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

async function renderPicker(props: Partial<Parameters<typeof AppScreenPicker>[0]> = {}) {
  const onPick = vi.fn()
  const onExit = vi.fn()
  render(<AppScreenPicker onPick={onPick} onExit={onExit} t={t} {...props} />)
  await screen.findByRole('switch', { name: 'Discord' })
  return { onPick, onExit }
}

describe('AppScreenPicker', () => {
  it('shows windows with the real app icon and the sound panel beside them', async () => {
    await renderPicker()
    expect(screen.getByRole('radio', { name: 'Telas' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Janelas' }))
    const card = await screen.findByRole('radio', { name: /YouTube/ })
    expect(card.querySelector(`img[src="${CHROME_ICON}"]`)).not.toBeNull()
    const sound = screen.getByRole('region', { name: 'Som' })
    expect(within(sound).getByRole('switch', { name: 'Discord' })).toHaveAttribute('aria-checked', 'false')
    expect(within(sound).getByRole('switch', { name: 'Google Chrome' })).toHaveAttribute('aria-checked', 'true')
    expect(sound.querySelector(`img[src="${DISCORD_ICON}"]`)).not.toBeNull()
    expect(within(sound).getByRole('button', { name: 'Silenciar tudo' })).toBeInTheDocument()
  })

  it('a switch takes the app out of the sound and back', async () => {
    await renderPicker()
    fireEvent.click(screen.getByRole('switch', { name: 'Google Chrome' }))
    expect(getSoundChoice().muted).toEqual(['discord', 'chrome'])
    expect(screen.getByRole('switch', { name: 'Google Chrome' })).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('switch', { name: 'Discord' }))
    expect(getSoundChoice().muted).toEqual(['chrome'])
  })

  it('silences everything at once, and brings everything back', async () => {
    await renderPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Silenciar tudo' }))
    expect(getSoundChoice().enabled).toBe(false)
    expect(screen.getAllByRole('switch').every((element) => element.getAttribute('aria-checked') === 'false')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Ligar tudo' }))
    expect(getSoundChoice()).toEqual({ enabled: true, muted: [] })
  })

  it('an app switched on while everything is silent brings only that app back', async () => {
    await renderPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Silenciar tudo' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Google Chrome' }))
    expect(getSoundChoice().enabled).toBe(true)
    expect([...getSoundChoice().muted].sort()).toEqual(['discord', 'system'])
  })

  it('shares the chosen window with the quality and the apps left out', async () => {
    const { onPick } = await renderPicker()
    fireEvent.click(screen.getByRole('radio', { name: 'Janelas' }))
    fireEvent.click(await screen.findByRole('radio', { name: /YouTube/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }))
    expect(onPick).toHaveBeenCalledWith({ target: { kind: 'window', id: 'w1' }, quality: '1080p60', audio: true, muted: ['discord'] })
  })

  it('keeps the thumbnails and the app list fresh while open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await renderPicker()
    const thumbs = vi.mocked(appThumbnail).mock.calls.length
    const lists = vi.mocked(appAudioApps).mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(vi.mocked(appThumbnail).mock.calls.length).toBeGreaterThan(thumbs)
    expect(vi.mocked(appAudioApps).mock.calls.length).toBeGreaterThan(lists)
  })

  it('while the share starts, the button keeps its words and says it is working', async () => {
    await renderPicker({ busy: true })
    expect(screen.getByRole('button', { name: 'Compartilhar' })).toHaveAttribute('aria-busy', 'true')
  })
})
