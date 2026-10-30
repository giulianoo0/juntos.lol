import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desktop, resetDesktopForTests } from '../platform'
import { publishEncodedScreen } from '../screenshare'
import { startH264Feed } from '../jlocal/h264Feed'
import { appAudioTrack, startAppFeed, type AppFeed } from '../desktop/screen'
import { resetSoundChoiceForTests, setAppMuted, setSoundEnabled } from '../jlocal/soundChoice'
import { useScreenShare, type JlocalPick } from './useScreenShare'

const publisher = {
  status: { peek: () => 'connected', subscribe: () => () => undefined },
  ready: Promise.resolve(),
  setQuality: vi.fn(async () => undefined),
  switchStream: vi.fn(),
  switchSource: vi.fn(async () => undefined),
  setAudio: vi.fn(),
  sample: () => null,
  close: vi.fn(),
}

vi.mock('../screenshare', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../screenshare')>()),
  fetchScreenRelay: vi.fn(async () => ({ url: 'https://relay.test/token', base: 'juntos/r1/secret', path: 'juntos/r1/secret/m1.hang', publish: true, open: true })),
  publishEncodedScreen: vi.fn(async () => publisher),
  screenShareSupported: vi.fn(() => true),
  takeScreenStream: vi.fn(() => null),
  setScreenLive: vi.fn(async () => undefined),
}))

const fakeFeed = () => ({
  captureId: null, width: 1920, height: 1080, fps: 60, bitrate: 10_000_000,
  open: vi.fn(() => () => undefined),
  stop: vi.fn(),
  retarget: vi.fn(async () => undefined),
})

vi.mock('../jlocal/h264Feed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jlocal/h264Feed')>()),
  startH264Feed: vi.fn(async () => fakeFeed()),
  systemAudioTrack: vi.fn(() => null),
  previewH264: vi.fn(() => () => undefined),
}))

const audio = { track: {} as MediaStreamTrack, setMuted: vi.fn(), stop: vi.fn() }

vi.mock('../desktop/screen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../desktop/screen')>()),
  startAppFeed: vi.fn(async () => fakeFeed()),
  appAudioTrack: vi.fn(() => audio),
}))

async function installApp(features: string[]) {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => (cmd === 'app_hello' ? { protocolVersion: 1, version: '0.2.0', compatible: true, features, mediaRoot: 'juntos-media://localhost' } : null),
  }
  resetDesktopForTests()
  await desktop()
}

const pick: JlocalPick = { target: { kind: 'display', id: '1' }, quality: '1080p60', audio: true }

function renderShare() {
  return renderHook(() => useScreenShare({ roomId: 'r1', memberId: 'm1', nickname: 'Ana', capability: 'cap', isController: true, shareOpen: false, screens: [] }))
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSoundChoiceForTests()
  vi.stubGlobal('MediaStream', class { getTracks() { return [] } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  resetDesktopForTests()
})

describe('useScreenShare through the desktop app', () => {
  it('picks the app over jlocal when the app can capture', async () => {
    await installApp(['screenCapture'])
    const { result } = renderShare()
    await act(() => result.current.startWithJlocal(pick))
    expect(startAppFeed).toHaveBeenCalledWith({ target: pick.target, width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 })
    expect(startH264Feed).not.toHaveBeenCalled()
    expect(appAudioTrack).toHaveBeenCalledWith(['discord'])
    expect(publishEncodedScreen).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ width: 1920, height: 1080 }), audio.track)
    expect(result.current.viaApp).toBe(true)
  })

  it('keeps jlocal when the app cannot capture', async () => {
    await installApp(['localSource'])
    const { result } = renderShare()
    await act(() => result.current.startWithJlocal(pick))
    expect(startH264Feed).toHaveBeenCalled()
    expect(startAppFeed).not.toHaveBeenCalled()
    expect(result.current.viaApp).toBe(false)
  })

  it('moves the same capture to another window and keeps it running', async () => {
    await installApp(['screenCapture'])
    const { result } = renderShare()
    await act(() => result.current.startWithJlocal(pick))
    const feed = await vi.mocked(startAppFeed).mock.results[0].value as AppFeed
    await act(() => result.current.switchJlocal({ ...pick, target: { kind: 'window', id: '42' } }))
    expect(feed.retarget).toHaveBeenCalledWith({ target: { kind: 'window', id: '42' }, width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 })
    expect(publisher.switchSource).toHaveBeenCalledTimes(1)
    expect(feed.stop).not.toHaveBeenCalled()
    expect(startAppFeed).toHaveBeenCalledTimes(1)
  })

  it('changes the quality of a live app share in place', async () => {
    await installApp(['screenCapture'])
    const { result } = renderShare()
    await act(() => result.current.startWithJlocal(pick))
    const feed = await vi.mocked(startAppFeed).mock.results[0].value as AppFeed
    await act(async () => { result.current.setQuality('1440p60') })
    await vi.waitFor(() => expect(feed.retarget).toHaveBeenCalledWith(expect.objectContaining({ width: 2560, height: 1440, fps: 60 })))
    await vi.waitFor(() => expect(publisher.switchSource).toHaveBeenCalledTimes(1))
    expect(result.current.quality).toBe('1440p60')
  })

  it('sends a sound change to the app live, and silences the share when sound is off', async () => {
    await installApp(['screenCapture'])
    const { result } = renderShare()
    await act(() => result.current.startWithJlocal(pick))
    act(() => setAppMuted('spotify', true))
    expect(audio.setMuted).toHaveBeenLastCalledWith(['discord', 'spotify'])
    act(() => setSoundEnabled(false))
    expect(publisher.setAudio).toHaveBeenLastCalledWith(undefined)
    expect(audio.stop).toHaveBeenCalled()
    act(() => setSoundEnabled(true))
    expect(appAudioTrack).toHaveBeenLastCalledWith(['discord', 'spotify'])
    expect(publisher.setAudio).toHaveBeenLastCalledWith(audio.track)
  })
})
