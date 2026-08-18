import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { translate, type Translator } from '../i18n/useT'
import type { RoomInfo } from '../types'
import { Player } from './Player'

const t = Object.assign((key: string) => translate('en', key), {
  language: 'en' as const,
  setLanguage: vi.fn(),
}) as Translator

const room: RoomInfo = {
  id: 'r1',
  fileName: 'movie.mkv',
  status: 'ready',
  sourceKind: 'upload',
  mediaGeneration: 0,
  controllerId: 'm1',
  audioTracks: null,
  subtitleTracks: null,
  bitmapSubsSkipped: 0,
  memberCount: 1,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

afterEach(() => vi.restoreAllMocks())

describe('Player', () => {
  it('starts media inside the controller click before sending synchronized play', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const send = vi.fn()
    render(<Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={send} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: 'Play' }))

    expect(play).toHaveBeenCalledOnce()
    await waitFor(() => expect(send).toHaveBeenCalledWith('play', { positionMs: 0, rate: 1 }))
  })

  it('retries a play request when HLS becomes playable', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(new DOMException('MediaSource is not ready', 'AbortError'))
      .mockResolvedValueOnce(undefined)
    const send = vi.fn()
    render(<Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={send} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    await waitFor(() => expect(play).toHaveBeenCalledOnce())
    await Promise.resolve()
    fireEvent.canPlay(screen.getByRole('button', { name: 'Play' }).closest('.player-wrap')!.querySelector('video')!)

    await waitFor(() => expect(play).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(send).toHaveBeenCalledWith('play', { positionMs: 0, rate: 1 }))
  })

  it('lets a viewer satisfy autoplay locally without changing synchronized state', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const send = vi.fn()
    render(<Player room={room} isController={false} videoRef={createRef<HTMLVideoElement>()} send={send} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: 'Play' }))

    expect(play).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalledWith('play', expect.anything())
  })

  it('does not expose control takeover to viewers', () => {
    render(<Player room={room} isController={false} videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />)
    expect(screen.queryByRole('button', { name: 'Take control' })).not.toBeInTheDocument()
    expect(screen.getByText('Host controls sync')).toBeInTheDocument()
  })

  it('opens the player in fullscreen', () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })
    render(<Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }))

    expect(requestFullscreen).toHaveBeenCalledOnce()
  })

  it('hides playing controls after inactivity and restores them on pointer movement', () => {
    vi.useFakeTimers()
    const videoRef = createRef<HTMLVideoElement>()
    const { container } = render(<Player room={room} isController videoRef={videoRef} send={vi.fn()} t={t} />)
    const player = container.querySelector('.player-wrap')!

    fireEvent.play(videoRef.current!)
    act(() => vi.advanceTimersByTime(2500))
    expect(player).toHaveClass('controls-hidden')

    fireEvent.pointerMove(player)
    expect(player).not.toHaveClass('controls-hidden')
    vi.useRealTimers()
  })

  it('uses the current seekable end when an event playlist has infinite duration', () => {
    const videoRef = createRef<HTMLVideoElement>()
    render(<Player room={room} isController videoRef={videoRef} send={vi.fn()} t={t} />)
    const video = videoRef.current!
    Object.defineProperty(video, 'duration', { configurable: true, value: Number.POSITIVE_INFINITY })
    Object.defineProperty(video, 'seekable', {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 42 },
    })

    fireEvent.durationChange(video)

    expect(screen.getByText('0:00 / 0:42')).toBeInTheDocument()
  })

  it('opens fullscreen on a double click on the video', () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen })
    const videoRef = createRef<HTMLVideoElement>()
    render(<Player room={room} isController videoRef={videoRef} send={vi.fn()} t={t} />)

    fireEvent.doubleClick(videoRef.current!)

    expect(requestFullscreen).toHaveBeenCalledOnce()
  })

  it('ignores a double click aimed at the control bar', () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen })
    const { container } = render(<Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />)

    // Double clicking while working the scrubber must not fullscreen the page.
    fireEvent.doubleClick(container.querySelector('input[aria-label="Seek"]')!)

    expect(requestFullscreen).not.toHaveBeenCalled()
  })

  it('toggles playback with the space bar', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const send = vi.fn()
    render(<Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={send} t={t} />)

    fireEvent.keyDown(document, { key: ' ' })

    expect(play).toHaveBeenCalledOnce()
  })

  it('seeks with the arrow keys relative to the current position', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    render(<Player room={room} isController videoRef={videoRef} send={send} t={t} />)
    const video = videoRef.current!
    Object.defineProperty(video, 'duration', { configurable: true, value: 120 })
    fireEvent.durationChange(video)
    video.currentTime = 30

    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(send).toHaveBeenCalledWith('seek', { positionMs: 35_000 })

    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(send).toHaveBeenCalledWith('seek', { positionMs: 25_000 })

    // J and L are the wider jumps every video player binds.
    fireEvent.keyDown(document, { key: 'l' })
    expect(send).toHaveBeenCalledWith('seek', { positionMs: 40_000 })
  })

  it('never seeks past the ends of the media', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    render(<Player room={room} isController videoRef={videoRef} send={send} t={t} />)
    const video = videoRef.current!
    Object.defineProperty(video, 'duration', { configurable: true, value: 20 })
    fireEvent.durationChange(video)

    video.currentTime = 2
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(send).toHaveBeenCalledWith('seek', { positionMs: 0 })

    video.currentTime = 18
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(send).toHaveBeenCalledWith('seek', { positionMs: 20_000 })
  })

  it('rewinds correctly while the duration is still unknown', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    render(<Player room={room} isController videoRef={videoRef} send={send} t={t} />)
    videoRef.current!.currentTime = 30

    // A growing event playlist reports no duration; that must not clamp the
    // target to a negative position the server would reject.
    fireEvent.keyDown(document, { key: 'ArrowLeft' })

    expect(send).toHaveBeenCalledWith('seek', { positionMs: 25_000 })
  })

  it('does not let a viewer seek with the keyboard', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    render(<Player room={room} isController={false} videoRef={videoRef} send={send} t={t} />)
    videoRef.current!.currentTime = 30

    fireEvent.keyDown(document, { key: 'ArrowRight' })

    expect(send).not.toHaveBeenCalled()
  })

  it('leaves shortcuts alone while a text field has focus', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const send = vi.fn()
    render(<Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={send} t={t} />)
    const chatInput = document.createElement('input')
    document.body.appendChild(chatInput)

    // Writing a message in the chat must not drive the player.
    fireEvent.keyDown(chatInput, { key: ' ' })
    fireEvent.keyDown(chatInput, { key: 'ArrowRight' })

    expect(play).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    chatInput.remove()
  })

  it('adjusts and mutes volume locally without touching synchronized state', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    render(<Player room={room} isController videoRef={videoRef} send={send} t={t} />)
    const video = videoRef.current!

    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(video.volume).toBeCloseTo(0.95)

    fireEvent.keyDown(document, { key: 'm' })
    expect(video.muted).toBe(true)
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeInTheDocument()

    // Reaching for the volume implies wanting to hear it again.
    fireEvent.keyDown(document, { key: 'ArrowUp' })
    expect(video.muted).toBe(false)

    expect(send).not.toHaveBeenCalled()
  })

  it('toggles fullscreen with the f key', () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen })
    render(<Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />)

    fireEvent.keyDown(document, { key: 'f' })

    expect(requestFullscreen).toHaveBeenCalledOnce()
  })
})
