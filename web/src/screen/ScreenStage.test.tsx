import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ScreenStage } from './ScreenStage'
import { ToastProvider } from '../ui/Toast'
import { en } from '../i18n/en'
import { fetchScreenRelay, loadScreenQuality, setScreenShareOpen, watchScreen } from '../screenshare'

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
  setScreenShareOpen: vi.fn().mockResolvedValue(undefined),
}))

const t = Object.assign((key: string) => en[key] ?? key, {
  language: 'en' as const,
  setLanguage: () => undefined,
})

function renderStage(props: Partial<Parameters<typeof ScreenStage>[0]> = {}) {
  return render(
    <ToastProvider>
      <ScreenStage
        roomId="r1"
        memberId="m1"
        nickname="giuli"
        capability="cap"
        isController
        shareOpen
        screens={[]}
        t={t}
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

it('says nobody is sharing when the room lists no screen', async () => {
  renderStage({ memberId: 'm3', isController: false, shareOpen: false })
  await waitFor(() => expect(fetchScreenRelay).toHaveBeenCalled())
  expect(screen.getByText(en['room.screenWaiting'])).toBeTruthy()
  expect(watchScreen).not.toHaveBeenCalled()
})

it('lets the host close the room to guest sharing', async () => {
  renderStage()
  fireEvent.click(screen.getByRole('button', { name: en['room.screenOpenOn'] }))
  await waitFor(() => expect(setScreenShareOpen).toHaveBeenCalledWith('r1', 'm1', 'cap', false))
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
