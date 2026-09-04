import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { translate, type Translator } from '../i18n/useT'
import type { RoomInfo } from '../types'
import { Player } from './Player'
import { ToastProvider } from '../ui/Toast'

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

function playing(video: HTMLVideoElement) {
  Object.defineProperty(video, 'paused', { configurable: true, value: false })
}

const playingRoom = { playing: true, positionMs: 0, rate: 1, serverTimeMs: Date.now() }

afterEach(() => vi.restoreAllMocks())

describe('Player', () => {
  it('cuts the timeline at each chapter and names the one playing', () => {
    const chaptered: RoomInfo = {
      ...room,
      chapters: [
        { startMs: 0, endMs: 90_000, title: 'Abertura' },
        { startMs: 90_000, endMs: 1_200_000 },
      ],
    }
    const { container } = render(
      <Player room={chaptered} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />,
    )
    const video = container.querySelector('video')!
    Object.defineProperty(video, 'duration', { configurable: true, value: 1290 })
    fireEvent.durationChange(video)

    expect(container.querySelectorAll('.seek-chapter-tick')).toHaveLength(1)
    expect(screen.getByText(/· Abertura/)).toBeInTheDocument()
  })

  it('declares CORS on the media element so cross-origin tracks load', () => {
    const { container } = render(
      <Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />,
    )

    expect(container.querySelector('video')?.getAttribute('crossorigin')).toBe('anonymous')
  })

  it('reads subtitles from the bucket the room names', () => {
    const withSubs: RoomInfo = {
      ...room,
      subtitleTracks: [{ index: 0, language: 'por', title: 'Legendas', codec: 'webvtt' }],
      subsVersion: 3,
      mediaBaseUrl: 'https://media.example.test/rooms/r1/g0',
    }
    const { container } = render(
      <Player room={withSubs} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />,
    )

    expect(container.querySelector('track')?.getAttribute('src')).toBe(
      'https://media.example.test/rooms/r1/g0/subs/sub_0_por.vtt?g=0&s=3',
    )
  })

  it('names each subtitle file by the track it belongs to, not its place in the menu', () => {
    const sparse: RoomInfo = {
      ...room,
      subtitleTracks: [
        { index: 1, language: 'eng', title: '', codec: 'webvtt' },
        { index: 3, language: 'ara', title: 'Saudi Arabia', codec: 'webvtt' },
      ],
      subsVersion: 2,
      mediaBaseUrl: 'https://media.example.test/rooms/r1/g0',
    }
    const { container } = render(
      <Player room={sparse} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />,
    )

    const sources = [...container.querySelectorAll('track')].map((node) => node.getAttribute('src'))
    expect(sources).toEqual([
      'https://media.example.test/rooms/r1/g0/subs/sub_1_eng.vtt?g=0&s=2',
      'https://media.example.test/rooms/r1/g0/subs/sub_3_ara.vtt?g=0&s=2',
    ])
  })

  it('keeps the chosen subtitle on its own track as the menu fills in', async () => {
    const sparse: RoomInfo = {
      ...room,
      subtitleTracks: [
        { index: 1, language: 'eng', title: 'English', codec: 'webvtt' },
        { index: 3, language: 'por', title: 'Portugues', codec: 'webvtt' },
      ],
      mediaBaseUrl: 'https://media.example.test/rooms/r1/g0',
    }
    const { rerender } = render(
      <Player room={sparse} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /settings|configurações/i }))
    fireEvent.click(await screen.findByRole('button', { name: /subtitles|legendas/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Portugues' }))
    expect(screen.getByTestId('setting-subtitles')).toHaveTextContent('Portugues')

    const full: RoomInfo = {
      ...sparse,
      subtitleTracks: [
        { index: 0, language: 'eng', title: 'Forced', codec: 'webvtt' },
        ...(sparse.subtitleTracks ?? []),
        { index: 2, language: 'ara', title: 'Arabic', codec: 'webvtt' },
      ],
    }
    rerender(<Player room={full} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />)

    expect(screen.getByTestId('setting-subtitles')).toHaveTextContent('Portugues')
  })

  it('opens one settings group at a time, in place', async () => {
    const withTracks: RoomInfo = {
      ...room,
      subtitleTracks: [
        { index: 0, language: 'eng', title: 'English', codec: 'webvtt' },
        { index: 1, language: 'por', title: 'Portugues', codec: 'webvtt' },
      ],
      mediaBaseUrl: 'https://media.example.test/rooms/r1/g0',
    }
    render(<Player room={withTracks} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: /settings|configurações/i }))
    const subtitles = await screen.findByRole('button', { name: /subtitles|legendas/i })
    expect(subtitles).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'English' })).not.toBeInTheDocument()

    fireEvent.click(subtitles)

    expect(subtitles).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'English' })).toBeInTheDocument()
    expect(screen.getByTestId('setting-subtitles')).toBeInTheDocument()

    fireEvent.click(subtitles)
    expect(subtitles).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'English' })).not.toBeInTheDocument()
  })

  it('closes the settings when something outside them is pressed', async () => {
    const withTracks: RoomInfo = {
      ...room,
      subtitleTracks: [{ index: 0, language: 'eng', title: 'English', codec: 'webvtt' }],
      mediaBaseUrl: 'https://media.example.test/rooms/r1/g0',
    }
    render(<Player room={withTracks} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /settings|configurações/i }))
    fireEvent.click(await screen.findByRole('button', { name: /subtitles|legendas/i }))
    expect(screen.getByRole('button', { name: 'English' })).toBeInTheDocument()

    fireEvent.pointerDown(document.body)

    const gear = await screen.findByRole('button', { name: /settings|configurações/i })
    expect(gear).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(gear)
    expect(await screen.findByRole('button', { name: /subtitles|legendas/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'English' })).not.toBeInTheDocument()
  })

  it('offers no subtitles at all when the room names no bucket', () => {
    const withSubs: RoomInfo = {
      ...room,
      subtitleTracks: [{ index: 0, language: 'por', title: 'Legendas', codec: 'webvtt' }],
    }
    const { container } = render(
      <Player room={withSubs} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />,
    )

    expect(container.querySelector('track')).toBeNull()
    expect(screen.queryByRole('button', { name: /settings|configurações/i })).not.toBeInTheDocument()
  })

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

  it('takes a native pause to the whole room', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const playing = { playing: true, positionMs: 12_000, rate: 1, serverTimeMs: Date.now() }
    render(<Player room={room} isController videoRef={videoRef} send={send} t={t} syncState={playing} serverOffsetMs={0} />)

    const video = videoRef.current!
    video.currentTime = 12
    fireEvent.pause(video)

    expect(send).toHaveBeenCalledWith('pause', expect.objectContaining({ positionMs: 12_000 }))
  })

  it('reads a pause the server just performed as an echo, not as a gesture', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const remoteSteerAtRef = { current: Date.now() }
    const playing = { playing: true, positionMs: 12_000, rate: 1, serverTimeMs: 100_000 }
    render(
      <Player
        room={room} isController videoRef={videoRef} send={send} t={t}
        syncState={playing} serverOffsetMs={0} remoteSteerAtRef={remoteSteerAtRef}
      />,
    )

    fireEvent.pause(videoRef.current!)
    expect(send).not.toHaveBeenCalled()
  })

  it('asks for a gesture when the browser refuses to start, instead of retrying forever', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValue(new DOMException('gesture required', 'NotAllowedError'))
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const playing = { playing: true, positionMs: 0, rate: 1, serverTimeMs: 100_000 }
    const { container } = render(
      <Player room={room} isController={false} videoRef={videoRef} send={send} t={t} syncState={playing} serverOffsetMs={0} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    await waitFor(() => expect(container.querySelector('.player-gesture')).not.toBeNull())

    const before = play.mock.calls.length
    fireEvent.canPlay(videoRef.current!)
    await Promise.resolve()
    expect(play).toHaveBeenCalledTimes(before)
  })

  it('drops a stale play request rather than restarting a room that has since stopped', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(new DOMException('MediaSource is not ready', 'AbortError'))
      .mockResolvedValue(undefined)
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const stopped = { playing: false, positionMs: 0, rate: 1, serverTimeMs: Date.now() }
    const { rerender } = render(
      <Player room={room} isController videoRef={videoRef} send={send} t={t} syncState={stopped} serverOffsetMs={0} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    await waitFor(() => expect(play).toHaveBeenCalledOnce())
    await Promise.resolve()
    send.mockClear()

    rerender(
      <Player
        room={room} isController videoRef={videoRef} send={send} t={t}
        syncState={{ playing: false, positionMs: 0, rate: 1, serverTimeMs: Date.now() + 1 }} serverOffsetMs={0}
      />,
    )
    fireEvent.canPlay(videoRef.current!)
    await Promise.resolve()
    expect(play).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalledWith('play', expect.anything())
  })

  it('lets a viewer satisfy autoplay locally without changing synchronized state', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const send = vi.fn()
    render(
      <Player
        room={room}
        isController={false}
        videoRef={createRef<HTMLVideoElement>()}
        send={send}
        t={t}
        syncState={playingRoom}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Play' }))

    expect(play).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalledWith('play', expect.anything())
  })

  it('refuses a viewer starting playback the room has not started', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const send = vi.fn()
    render(
      <Player
        room={room}
        isController={false}
        videoRef={createRef<HTMLVideoElement>()}
        send={send}
        t={t}
        syncState={{ ...playingRoom, playing: false }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Play' }))

    expect(play).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a viewer pausing what the room is watching', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.useFakeTimers()
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    render(
      <Player room={room} isController={false} videoRef={videoRef} send={send} t={t} syncState={playingRoom} />,
    )
    playing(videoRef.current!)

    fireEvent.click(videoRef.current!)
    act(() => void vi.advanceTimersByTime(250))

    expect(pause).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('does not expose control takeover to viewers', () => {
    render(<Player room={room} isController={false} videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />)
    expect(screen.queryByRole('button', { name: 'Take control' })).not.toBeInTheDocument()
    expect(screen.queryByText(/only the host|só o líder/i)).not.toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Seek' })).toBeDisabled()
  })

  it('tells a viewer why pausing did nothing, and leaves playback alone', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    render(
      <ToastProvider>
        <Player room={room} isController={false} videoRef={videoRef} send={send} t={t} />
      </ToastProvider>,
    )
    fireEvent.play(videoRef.current!)
    Object.defineProperty(videoRef.current!, 'paused', { configurable: true, value: false })

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))

    expect(await screen.findByText(/only the host/i)).toBeInTheDocument()
    expect(pause).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith('pause', expect.anything())
  })

  it('tells a viewer why an arrow key did nothing', async () => {
    const send = vi.fn()
    render(
      <ToastProvider>
        <Player room={room} isController={false} videoRef={createRef<HTMLVideoElement>()} send={send} t={t} />
      </ToastProvider>,
    )

    fireEvent.keyDown(document, { key: 'ArrowRight' })

    expect(await screen.findByText(/only the host/i)).toBeInTheDocument()
    expect(send).not.toHaveBeenCalledWith('seek', expect.anything())
  })

  it('shows a spinner until the video can actually play', () => {
    const videoRef = createRef<HTMLVideoElement>()
    const { container } = render(
      <Player room={room} isController videoRef={videoRef} send={vi.fn()} t={t} />,
    )
    expect(container.querySelector('.player-loading')).toBeInTheDocument()

    fireEvent.canPlay(videoRef.current!)

    expect(container.querySelector('.player-loading')).not.toBeInTheDocument()
  })

  it('brings the spinner back when playback runs out of data', () => {
    const videoRef = createRef<HTMLVideoElement>()
    const { container } = render(
      <Player room={room} isController videoRef={videoRef} send={vi.fn()} t={t} />,
    )
    fireEvent.canPlay(videoRef.current!)

    fireEvent.waiting(videoRef.current!)
    expect(container.querySelector('.player-loading')).toBeInTheDocument()

    fireEvent.playing(videoRef.current!)
    expect(container.querySelector('.player-loading')).not.toBeInTheDocument()
  })

  it('reports a stall to the room only when the buffer ahead is actually thin', () => {
    const videoRef = createRef<HTMLVideoElement>()
    const onBuffering = vi.fn()
    const { container } = render(
      <Player room={room} isController videoRef={videoRef} send={vi.fn()} t={t} onBuffering={onBuffering} />,
    )
    const video = videoRef.current!
    fireEvent.canPlay(video)
    onBuffering.mockClear()

    video.currentTime = 10
    Object.defineProperty(video, 'buffered', { configurable: true, value: { length: 1, start: () => 0, end: () => 70 } })
    fireEvent.waiting(video)
    expect(container.querySelector('.player-loading')).toBeInTheDocument()
    expect(onBuffering).not.toHaveBeenCalledWith(true)

    Object.defineProperty(video, 'buffered', { configurable: true, value: { length: 1, start: () => 0, end: () => 10.2 } })
    fireEvent.waiting(video)
    expect(onBuffering).toHaveBeenCalledWith(true)
  })

  it('offers no quality control when there is only one rendition', () => {
    render(<Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />)
    expect(screen.queryByLabelText(/quality|qualidade/i)).not.toBeInTheDocument()
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
    const { container } = render(<Player room={room} isController videoRef={videoRef} send={vi.fn()} t={t} />)
    const video = videoRef.current!
    Object.defineProperty(video, 'duration', { configurable: true, value: Number.POSITIVE_INFINITY })
    Object.defineProperty(video, 'seekable', {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 42 },
    })

    fireEvent.durationChange(video)

    expect(container.querySelector('.timecode')?.textContent).toContain('0:00/0:42')
  })

  it('pauses when the video is tapped', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.useFakeTimers()
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    render(<Player room={room} isController videoRef={videoRef} send={send} t={t} />)
    playing(videoRef.current!)

    fireEvent.click(videoRef.current!)
    act(() => void vi.advanceTimersByTime(250))

    expect(pause).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith('pause', expect.objectContaining({ positionMs: 0 }))
    vi.useRealTimers()
  })

  it('ignores a click in the strip the control bar sits in', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.useFakeTimers()
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const { container } = render(<Player room={room} isController videoRef={videoRef} send={send} t={t} />)
    playing(videoRef.current!)
    const controls = container.querySelector('.player-controls') as HTMLElement
    controls.getBoundingClientRect = () => ({ top: 400, bottom: 460, height: 60, left: 0, right: 800, width: 800, x: 0, y: 400, toJSON: () => ({}) })

    fireEvent.click(videoRef.current!, { clientY: 430 })
    act(() => void vi.advanceTimersByTime(250))

    expect(pause).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()

    fireEvent.click(videoRef.current!, { clientY: 120 })
    act(() => void vi.advanceTimersByTime(250))
    expect(pause).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('does not touch playback when the tap turns out to be a double click', () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen })
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.useFakeTimers()
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    render(<Player room={room} isController videoRef={videoRef} send={send} t={t} />)
    playing(videoRef.current!)

    fireEvent.click(videoRef.current!)
    fireEvent.doubleClick(videoRef.current!)
    act(() => void vi.advanceTimersByTime(250))

    expect(pause).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(requestFullscreen).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('leaves a click on the control bar to its own buttons', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.useFakeTimers()
    const { container } = render(
      <Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />,
    )

    fireEvent.click(container.querySelector('input[aria-label="Seek"]')!)
    act(() => void vi.advanceTimersByTime(250))

    expect(play).not.toHaveBeenCalled()
    vi.useRealTimers()
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

    fireEvent.doubleClick(container.querySelector('input[aria-label="Seek"]')!)

    expect(requestFullscreen).not.toHaveBeenCalled()
  })

  it('still answers the space bar after a control was clicked', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen })
    render(<Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />)
    const fullscreen = screen.getByRole('button', { name: 'Enter fullscreen' })

    fullscreen.focus()
    fireEvent.keyDown(fullscreen, { key: ' ' })

    expect(play).toHaveBeenCalledOnce()
    expect(requestFullscreen).not.toHaveBeenCalled()
  })

  it('seeks five seconds with an arrow even while the scrubber has focus', () => {
    const send = vi.fn()
    const { container } = render(
      <Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={send} t={t} />,
    )
    const scrubber = container.querySelector('input[aria-label="Seek"]')! as HTMLInputElement

    scrubber.focus()
    fireEvent.keyDown(scrubber, { key: 'ArrowRight' })

    expect(send).toHaveBeenCalledWith('seek', { positionMs: 5000 })
  })

  it('leaves the arrow keys to the volume slider while it has focus', () => {
    const videoRef = createRef<HTMLVideoElement>()
    const { container } = render(
      <Player room={room} isController videoRef={videoRef} send={vi.fn()} t={t} />,
    )
    const slider = container.querySelector('input.volume-range')! as HTMLInputElement

    slider.focus()
    fireEvent.keyDown(slider, { key: 'ArrowDown' })

    expect(videoRef.current!.volume).toBe(1)
  })

  it('leaves the space bar to controls outside the player', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    render(
      <>
        <button type="button">Send</button>
        <Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />
      </>,
    )
    const outside = screen.getByRole('button', { name: 'Send' })

    outside.focus()
    fireEvent.keyDown(outside, { key: ' ' })

    expect(play).not.toHaveBeenCalled()
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
    expect(send).toHaveBeenCalledTimes(1)
    video.currentTime = 35
    fireEvent.timeUpdate(video)

    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(send).toHaveBeenCalledWith('seek', { positionMs: 30_000 })
    video.currentTime = 30
    fireEvent.timeUpdate(video)

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

    fireEvent.keyDown(document, { key: 'ArrowUp' })
    expect(video.muted).toBe(false)

    expect(send).not.toHaveBeenCalled()
  })

  it('shows the LIVE control only to viewers and seeks locally without publishing', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const syncState = { playing: true, positionMs: 60_000, rate: 1, serverTimeMs: 100_000 }
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const { rerender } = render(
      <Player room={room} isController videoRef={videoRef} send={send} t={t} syncState={syncState} serverOffsetMs={0} />,
    )

    expect(screen.queryByRole('button', { name: 'LIVE' })).not.toBeInTheDocument()

    rerender(
      <Player room={room} isController={false} videoRef={videoRef} send={send} t={t} syncState={syncState} serverOffsetMs={0} />,
    )
    const video = videoRef.current!
    video.currentTime = 10
    fireEvent.timeUpdate(video)
    const live = screen.getByRole('button', { name: 'LIVE' })
    expect(live).not.toHaveClass('is-live')

    fireEvent.click(live)

    expect(video.currentTime).toBe(60)
    expect(send).not.toHaveBeenCalled()
    fireEvent.timeUpdate(video)
    expect(screen.getByRole('button', { name: 'LIVE' })).toHaveClass('is-live')
  })

  it('renders every buffered range split into behind and ahead of the playhead', () => {
    const videoRef = createRef<HTMLVideoElement>()
    const { container } = render(<Player room={room} isController videoRef={videoRef} send={vi.fn()} t={t} />)
    const video = videoRef.current!
    Object.defineProperty(video, 'duration', { configurable: true, value: 100 })
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      value: { length: 2, start: (i: number) => [0, 50][i], end: (i: number) => [20, 70][i] },
    })
    video.currentTime = 10

    fireEvent.timeUpdate(video)

    expect(container.querySelectorAll('.seek-behind')).toHaveLength(1)
    expect(container.querySelectorAll('.seek-ahead')).toHaveLength(2)
    expect(container.querySelector<HTMLElement>('.seek-played')!.style.width).toBe('10%')
    const behind = container.querySelector<HTMLElement>('.seek-behind')!
    expect(behind.style.left).toBe('0%')
    expect(behind.style.width).toBe('10%')
    const ahead = container.querySelectorAll<HTMLElement>('.seek-ahead')
    expect(ahead[0].style.left).toBe('10%')
    expect(ahead[0].style.width).toBe('10%')
    expect(ahead[1].style.left).toBe('50%')
    expect(ahead[1].style.width).toBe('20%')
    expect(container.querySelector('input[aria-label="Seek"]')).toBeInTheDocument()
  })

  it('toggles fullscreen with the f key', () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen })
    render(<Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />)

    fireEvent.keyDown(document, { key: 'f' })

    expect(requestFullscreen).toHaveBeenCalledOnce()
  })
})

describe('region offset', () => {
  const offsetRoom: RoomInfo = {
    ...room,
    mediaOffsetMs: 1_080_000,
    durationMs: 1_440_000,
    mediaVersion: 3,
  }

  it('draws the whole episode, not the region, on the scrubber', () => {
    const { container } = render(
      <Player room={offsetRoom} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />,
    )
    const scrubber = container.querySelector('input[aria-label="Seek"]')! as HTMLInputElement
    expect(Number(scrubber.max)).toBe(1440)
  })

  it('reports seeks in absolute room time', () => {
    const send = vi.fn()
    const { container } = render(
      <Player room={offsetRoom} isController videoRef={createRef<HTMLVideoElement>()} send={send} t={t} />,
    )
    const scrubber = container.querySelector('input[aria-label="Seek"]')! as HTMLInputElement
    scrubber.focus()
    fireEvent.keyDown(scrubber, { key: 'ArrowRight' })
    expect(send).toHaveBeenCalledWith('seek', { positionMs: 1_085_000 })
  })

  it('shows the clock as absolute time', () => {
    const videoRef = createRef<HTMLVideoElement>()
    const { container } = render(
      <Player room={offsetRoom} isController videoRef={videoRef} send={vi.fn()} t={t} />,
    )
    fireEvent.timeUpdate(videoRef.current!)
    expect(container.querySelector('.timecode')?.textContent).toContain('18:00/24:00')
  })
})

describe('scrubbing', () => {
  const longRoom: RoomInfo = { ...room, durationMs: 1_440_000 }

  it('sends one seek per drag, on release, at the released position', () => {
    const send = vi.fn()
    const { container } = render(
      <Player room={longRoom} isController videoRef={createRef<HTMLVideoElement>()} send={send} t={t} />,
    )
    const scrubber = container.querySelector('input[aria-label="Seek"]')! as HTMLInputElement
    fireEvent.pointerDown(scrubber)
    fireEvent.change(scrubber, { target: { value: '600' } })
    fireEvent.change(scrubber, { target: { value: '1220' } })
    expect(send).not.toHaveBeenCalled()
    expect(scrubber.value).toBe('1220')
    fireEvent.pointerUp(scrubber)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('seek', { positionMs: 1_220_000 })
  })

  it('keeps the thumb on the target while the video has not arrived', () => {
    const videoRef = createRef<HTMLVideoElement>()
    const { container } = render(
      <Player room={longRoom} isController videoRef={videoRef} send={vi.fn()} t={t} />,
    )
    const scrubber = container.querySelector('input[aria-label="Seek"]')! as HTMLInputElement
    fireEvent.pointerDown(scrubber)
    fireEvent.change(scrubber, { target: { value: '1220' } })
    fireEvent.pointerUp(scrubber)
    fireEvent.timeUpdate(videoRef.current!)
    expect(scrubber.value).toBe('1220')
  })

  it('parks a playing room on a cold seek and resumes when the region lands', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const playing = { playing: true, positionMs: 120_000, rate: 1, serverTimeMs: Date.now() }
    const { container, rerender } = render(
      <Player room={longRoom} isController videoRef={videoRef} send={send} t={t} syncState={playing} serverOffsetMs={0} />,
    )
    const video = videoRef.current!
    Object.defineProperty(video, 'duration', { configurable: true, value: 300 })
    fireEvent.durationChange(video)
    video.currentTime = 120
    fireEvent.timeUpdate(video)
    const scrubber = container.querySelector('input[aria-label="Seek"]')! as HTMLInputElement
    fireEvent.pointerDown(scrubber)
    fireEvent.change(scrubber, { target: { value: '1220' } })
    fireEvent.pointerUp(scrubber)
    expect(send).toHaveBeenCalledWith('seek', { positionMs: 1_220_000 })
    expect(send).toHaveBeenCalledWith('pause', expect.objectContaining({ positionMs: 1_220_000 }))
    send.mockClear()
    rerender(
      <Player
        room={{ ...longRoom, mediaVersion: 1, mediaOffsetMs: 1_219_000 }}
        isController
        videoRef={videoRef}
        send={send}
        t={t}
        syncState={{ ...playing, playing: false, positionMs: 1_220_000 }}
        serverOffsetMs={0}
      />,
    )
    expect(send).not.toHaveBeenCalledWith('play', expect.anything())
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 40 },
    })
    video.currentTime = 1
    fireEvent.progress(video)
    fireEvent.timeUpdate(video)
    expect(send).toHaveBeenCalledWith('play', expect.objectContaining({ positionMs: 1_220_000 }))
  })

  it('a play behind a cold seek resumes at the room\'s position, not the element\'s', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const parked = { playing: false, positionMs: 1_220_000, rate: 1, serverTimeMs: 100_000 }
    const { container } = render(
      <Player room={longRoom} isController videoRef={videoRef} send={send} t={t} syncState={parked} serverOffsetMs={0} />,
    )
    const video = videoRef.current!
    video.currentTime = 120
    video.play = vi.fn(() => Promise.resolve())
    const playButton = container.querySelector('button.is-play')! as HTMLButtonElement
    fireEvent.click(playButton)
    return Promise.resolve().then(() => {
      expect(send).toHaveBeenCalledWith('play', expect.objectContaining({ positionMs: 1_220_000 }))
    })
  })

  it('refuses the controls while no region covers the room, rather than commanding a room that cannot obey', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const regioned = { ...longRoom, mediaRegions: [{ n: 0, startMs: 0, producedMs: 300_000, growing: true }] }
    const parked = { playing: false, positionMs: 1_220_000, rate: 1, serverTimeMs: 100_000 }
    const { container } = render(
      <Player room={regioned} isController videoRef={videoRef} send={send} t={t} syncState={parked} serverOffsetMs={0} />,
    )

    expect(container.querySelector('.player-loading')).not.toBeNull()
    const playButton = container.querySelector('button.is-play')! as HTMLButtonElement
    expect(playButton).toBeDisabled()

    const video = videoRef.current!
    video.play = vi.fn(() => Promise.resolve())
    fireEvent.click(playButton)
    expect(send).not.toHaveBeenCalled()
    expect(video.play).not.toHaveBeenCalled()
  })

  it('reads the thumb off the room clock while the region is still being built', () => {
    const videoRef = createRef<HTMLVideoElement>()
    const regioned = { ...longRoom, mediaRegions: [{ n: 0, startMs: 0, producedMs: 300_000, growing: true }] }
    const parked = { playing: false, positionMs: 1_220_000, rate: 1, serverTimeMs: 100_000 }
    render(
      <Player room={regioned} isController videoRef={videoRef} send={vi.fn()} t={t} syncState={parked} serverOffsetMs={0} />,
    )

    const video = videoRef.current!
    video.currentTime = 42
    fireEvent.timeUpdate(video)

    const slider = screen.getByLabelText('Seek') as HTMLInputElement
    expect(Number(slider.value)).toBe(1220)
  })

  it('parks a room with no region map that has run past what the element holds', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const ahead = { playing: true, positionMs: 1_220_000, rate: 1, serverTimeMs: 100_000 }
    const { container } = render(
      <Player room={longRoom} isController videoRef={videoRef} send={send} t={t} syncState={ahead} serverOffsetMs={0} />,
    )
    const video = videoRef.current!
    video.pause = vi.fn()
    Object.defineProperty(video, 'duration', { configurable: true, value: 300 })
    fireEvent.durationChange(video)

    expect(container.querySelector('.player-preparing')).not.toBeNull()
    expect(video.pause).toHaveBeenCalled()
  })

  it('parks a playing room on a warm seek too, until the buffer under the target is built', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const playing = { playing: true, positionMs: 120_000, rate: 1, serverTimeMs: Date.now() }
    const { container } = render(
      <Player room={longRoom} isController videoRef={videoRef} send={send} t={t} syncState={playing} serverOffsetMs={0} />,
    )
    const video = videoRef.current!
    Object.defineProperty(video, 'duration', { configurable: true, value: 1_440 })
    fireEvent.durationChange(video)
    video.currentTime = 120
    fireEvent.timeUpdate(video)
    const scrubber = container.querySelector('input[aria-label="Seek"]')! as HTMLInputElement
    fireEvent.pointerDown(scrubber)
    fireEvent.change(scrubber, { target: { value: '1220' } })
    fireEvent.pointerUp(scrubber)
    expect(send).toHaveBeenCalledWith('seek', { positionMs: 1_220_000 })
    expect(send).toHaveBeenCalledWith('pause', expect.objectContaining({ positionMs: 1_220_000 }))
  })

  it('catches a paused element up to a room that is already playing, without telling the room', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const playing = { playing: true, positionMs: 12_000, rate: 1, serverTimeMs: 100_000 }
    render(
      <Player room={room} isController videoRef={videoRef} send={send} t={t} syncState={playing} serverOffsetMs={0} />,
    )

    fireEvent.loadedData(videoRef.current!)
    await waitFor(() => expect(play).toHaveBeenCalled())
    expect(send).not.toHaveBeenCalledWith('play', expect.anything())
  })

})
