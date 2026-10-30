import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScreenStage } from './ScreenStage'
import { useScreenShare } from './useScreenShare'
import { ToastProvider } from '../ui/Toast'
import { en } from '../i18n/en'
import { fetchScreenRelay, loadScreenQuality, watchScreen } from '../screenshare'
import { desktop, resetDesktopForTests } from '../platform'
import { startAppFeed } from '../desktop/screen'
import { resetSoundChoiceForTests } from '../jlocal/soundChoice'

vi.mock('../screenshare', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../screenshare')>()),
  fetchScreenRelay: vi.fn().mockResolvedValue({
    url: 'https://relay.test/token', base: 'juntos/r1/secret', path: 'juntos/r1/secret/m1.hang', publish: true, open: true,
  }),
  watchScreen: vi.fn().mockResolvedValue({
    status: { peek: () => 'loading', subscribe: () => () => undefined },
    muted: { set: vi.fn() },
    close: vi.fn(),
  }),
  screenShareSupported: vi.fn().mockReturnValue(true),
  publishScreen: vi.fn(),
  requestScreenStream: vi.fn(),
  takeScreenStream: vi.fn().mockReturnValue(null),
  setScreenLive: vi.fn().mockResolvedValue(undefined),
  publishEncodedScreen: vi.fn().mockResolvedValue({
    status: { peek: () => 'connected', subscribe: () => () => undefined },
    ready: Promise.resolve(),
    setQuality: vi.fn(),
    switchStream: vi.fn(),
    switchSource: vi.fn().mockResolvedValue(undefined),
    setAudio: vi.fn(),
    sample: () => null,
    close: vi.fn(),
  }),
}))

const appAudio = { track: {} as MediaStreamTrack, setMuted: vi.fn(), stop: vi.fn() }

vi.mock('../desktop/screen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../desktop/screen')>()),
  startAppFeed: vi.fn(async () => ({
    captureId: null, width: 1920, height: 1080, fps: 60, bitrate: 10_000_000,
    open: () => () => undefined, stop: vi.fn(), retarget: vi.fn(async () => undefined),
  })),
  appAudioTrack: vi.fn(() => appAudio),
  appSources: vi.fn(async () => ({ displays: [{ id: 'd1', name: 'Display 1', width: 2560, height: 1440 }], windows: [] })),
  appScreenPermitted: vi.fn(async () => true),
  appThumbnail: vi.fn(async () => null),
  appAudioApps: vi.fn(async () => [
    { id: 'chrome', name: 'Google Chrome', icon: '' },
    { id: 'discord', name: 'Discord', icon: '' },
    { id: 'system', name: 'System sounds', icon: '' },
  ]),
}))

const t = Object.assign((key: string) => en[key] ?? key, {
  language: 'en' as const,
  setLanguage: () => undefined,
})

type HarnessProps = Omit<Parameters<typeof useScreenShare>[0], 'onScreenStarted'> & { viewers: number }

function Harness({ viewers, ...props }: HarnessProps) {
  const share = useScreenShare(props)
  return <ScreenStage share={share} memberId={props.memberId} viewers={viewers} t={t} />
}

function renderStage(props: Partial<HarnessProps> = {}) {
  return render(
    <ToastProvider>
      <Harness
        roomId="r1"
        memberId="m1"
        nickname="giuli"
        capability="cap"
        isController
        shareOpen
        screens={[]}
        viewers={1}
        {...props}
      />
    </ToastProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

it('gives every listed screen a tile of its own', async () => {
  renderStage({
    memberId: 'm3',
    isController: false,
    screens: [
      { memberId: 'm1', nickname: 'giuli', since: '2026-01-01T00:00:00Z' },
      { memberId: 'm2', nickname: 'enzoka', since: '2026-01-01T00:00:10Z' },
    ],
  })

  await waitFor(() => expect(watchScreen).toHaveBeenCalledTimes(2))
  expect(vi.mocked(watchScreen).mock.calls.map((call) => call[1])).toEqual([
    'juntos/r1/secret/m1.hang',
    'juntos/r1/secret/m2.hang',
  ])
  expect(screen.getByText('giuli')).toBeTruthy()
  expect(screen.getByText('enzoka')).toBeTruthy()
})

it('holds the place of a screen still on its way, without writing that it connects', async () => {
  renderStage({
    memberId: 'm3',
    isController: false,
    screens: [{ memberId: 'm1', nickname: 'giuli', since: '2026-01-01T00:00:00Z' }],
  })

  await waitFor(() => expect(watchScreen).toHaveBeenCalledTimes(1))
  const tile = await screen.findByRole('status')
  expect(tile).toHaveAttribute('aria-busy', 'true')
  expect(tile).toHaveTextContent(/^Loading$/)
})

it('says nobody is sharing when the room lists no screen', async () => {
  renderStage({ memberId: 'm3', isController: false, shareOpen: false })
  await waitFor(() => expect(fetchScreenRelay).toHaveBeenCalled())
  expect(screen.getByText(en['room.screenWaiting'])).toBeTruthy()
  expect(watchScreen).not.toHaveBeenCalled()
})

it('remembers the picked quality', async () => {
  renderStage()
  fireEvent.click(screen.getByRole('button', { name: en['room.screenQuality'] }))
  fireEvent.click(await screen.findByRole('option', { name: '4K · 60 fps' }))
  await waitFor(() => expect(loadScreenQuality()).toBe('2160p60'))
})

it('offers no publish controls to a guest of a closed room', async () => {
  renderStage({ memberId: 'm2', isController: false, shareOpen: false })
  await waitFor(() => expect(fetchScreenRelay).toHaveBeenCalled())
  expect(screen.queryByRole('button', { name: en['room.screenStart'] })).toBeNull()
})

it('puts the shared screen in fullscreen, and pins it over the page on a phone without the API', async () => {
  const requestFullscreen = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen })
  const screens = [{ memberId: 'm1', nickname: 'giuli', since: '2026-01-01T00:00:00Z' }]
  const { unmount } = renderStage({ memberId: 'm3', isController: false, screens })
  fireEvent.click(await screen.findByRole('button', { name: en['room.fullscreen'] }))
  expect(requestFullscreen).toHaveBeenCalledOnce()
  unmount()

  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: undefined })
  renderStage({ memberId: 'm3', isController: false, screens })
  fireEvent.click(await screen.findByRole('button', { name: en['room.fullscreen'] }))
  expect(document.querySelector('.screen-stage')).toHaveClass('is-pseudo-fullscreen')
})

describe('through the desktop app', () => {
  beforeEach(async () => {
    resetSoundChoiceForTests()
    vi.stubGlobal('MediaStream', class { getTracks() { return [] } })
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => (cmd === 'app_hello' ? { protocolVersion: 1, version: '0.2.0', compatible: true, features: ['screenCapture'], mediaRoot: 'juntos-media://localhost' } : null),
    }
    resetDesktopForTests()
    await desktop()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    resetDesktopForTests()
  })

  const findBar = () => waitFor(() => {
    const bar = document.querySelector<HTMLElement>('.screen-bar')
    if (!bar) throw new Error('the live bar is not up')
    return bar
  })

  async function shareThroughApp() {
    renderStage()
    fireEvent.click(screen.getByRole('button', { name: en['room.screenStart'] }))
    const dialog = await screen.findByRole('dialog', { name: en['appScreen.title'] })
    await within(dialog).findByRole('switch', { name: 'Discord' })
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'Display 1' }))
    fireEvent.click(within(dialog).getByRole('button', { name: en['appScreen.share'] }))
    await waitFor(() => expect(startAppFeed).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  }

  it('opens the app picker, and the live bar carries the sound app by app, the quality and stop', async () => {
    await shareThroughApp()
    const bar = await findBar()
    const sound = within(bar).getByRole('button', { name: en['appScreen.sound'] })
    await waitFor(() => expect(sound).toHaveTextContent('2 apps'))
    expect(within(bar).getByRole('button', { name: en['room.screenQuality'] })).toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: en['room.screenStop'] })).toBeInTheDocument()
    fireEvent.click(sound)
    fireEvent.click(await screen.findByRole('switch', { name: 'Google Chrome' }))
    expect(appAudio.setMuted).toHaveBeenLastCalledWith(expect.objectContaining({ muted: ['chrome'], unmuted: [] }))
  })

  it('switching the source reopens the app picker to swap on the same share', async () => {
    await shareThroughApp()
    const bar = await findBar()
    fireEvent.click(within(bar).getByRole('button', { name: en['room.screenSwitch'] }))
    const dialog = await screen.findByRole('dialog', { name: en['room.screenSwitch'] })
    expect(within(dialog).getByRole('button', { name: en['appScreen.switch'] })).toBeInTheDocument()
  })
})
