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

// playing marks one element as mid-playback. Defined on the instance rather
// than the prototype, so it cannot leak into the next test.
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
    // Chapters clamp to the seekable range, and jsdom's <video> never reports
    // one on its own: hand it the episode's duration.
    const video = container.querySelector('video')!
    Object.defineProperty(video, 'duration', { configurable: true, value: 1290 })
    fireEvent.durationChange(video)

    // One boundary between two chapters: a tick at 0 would cut nothing.
    expect(container.querySelectorAll('.seek-chapter-tick')).toHaveLength(1)
    // Playback sits at 0:00, inside the named opening.
    expect(screen.getByText(/· Abertura/)).toBeInTheDocument()
  })

  it('declares CORS on the media element so cross-origin tracks load', () => {
    // Subtitle files live on the media host. A browser refuses a cross-origin
    // text track unless the element itself declares CORS, and the failure is
    // silent: the tracks are listed and simply never fetched.
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
    // A progressive extraction only announces the tracks that hold a cue so
    // far, so the list arrives with gaps: a forced track carries nothing until
    // the first foreign sign appears on screen. The published file is named
    // after the track's real position, so reading the menu position instead
    // fetches somebody else's language, or a file that is not there yet.
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
    // The announced list grows while the extraction runs: forced tracks join it
    // once they hold a cue, and every one of them lands ahead of the languages
    // that were already there. A choice remembered as a menu position therefore
    // slides onto a different language mid-episode.
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

  // Each group opens where it stands. A menu that replaced the panel would
  // lose the other two, and the settings would stop being one surface.
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
    // The group it opened from is still there to go back to.
    expect(screen.getByTestId('setting-subtitles')).toBeInTheDocument()

    fireEvent.click(subtitles)
    expect(subtitles).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'English' })).not.toBeInTheDocument()
  })

  // Settings laid over the picture have to get out of the way the moment
  // attention moves back to it, without hunting for a close button.
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

    // The panel shrinks back into the gear it grew out of.
    const gear = await screen.findByRole('button', { name: /settings|configurações/i })
    expect(gear).toHaveAttribute('aria-expanded', 'false')
    // The group it had open goes with it, so reopening starts from the top.
    fireEvent.click(gear)
    expect(await screen.findByRole('button', { name: /subtitles|legendas/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'English' })).not.toBeInTheDocument()
  })

  it('offers no subtitles at all when the room names no bucket', () => {
    // This server stopped serving subtitle files, so a track without a base
    // would be one the browser can never load — and a choice that cannot take
    // effect is worse than no choice.
    const withSubs: RoomInfo = {
      ...room,
      subtitleTracks: [{ index: 0, language: 'por', title: 'Legendas', codec: 'webvtt' }],
    }
    const { container } = render(
      <Player room={withSubs} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />,
    )

    expect(container.querySelector('track')).toBeNull()
    // Nothing else here is choosable either, so the panel stays away entirely.
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

  it('lets a viewer satisfy autoplay locally without changing synchronized state', () => {
    // The room is already playing and the browser refused to start audio, so
    // the gesture starts their own element and reports nothing upstream.
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
    // Anything else would be a viewer deciding what the room watches, and
    // would leave them playing alone against a paused room.
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
    // The bar no longer carries a standing note about who is in charge: it is
    // said when a control is actually used, and not before.
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
    // A playing video is what turns the control into a pause.
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
    // A room whose source is still downloading starts here, and without this
    // the picture is just black with no sign anything is happening.
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

  it('offers no quality control when there is only one rendition', () => {
    render(<Player room={room} isController videoRef={createRef<HTMLVideoElement>()} send={vi.fn()} t={t} />)
    // A single-quality source has nothing to choose between, and an empty
    // menu is worse than none.
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

    // The clock is a row of animated digits, so it is read off the element
    // rather than matched as one string.
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
    // Reaching for the scrub bar and landing a few pixels off it used to
    // pause the room for everyone.
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.useFakeTimers()
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const { container } = render(<Player room={room} isController videoRef={videoRef} send={send} t={t} />)
    playing(videoRef.current!)
    const controls = container.querySelector('.player-controls') as HTMLElement
    // jsdom lays nothing out, so the bar is given a place in the frame.
    controls.getBoundingClientRect = () => ({ top: 400, bottom: 460, height: 60, left: 0, right: 800, width: 800, x: 0, y: 400, toJSON: () => ({}) })

    fireEvent.click(videoRef.current!, { clientY: 430 })
    act(() => void vi.advanceTimersByTime(250))

    expect(pause).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()

    // The picture above it still is a play/pause target.
    fireEvent.click(videoRef.current!, { clientY: 120 })
    act(() => void vi.advanceTimersByTime(250))
    expect(pause).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('does not touch playback when the tap turns out to be a double click', () => {
    // Acting on the first click would pause and then play again, sending both
    // over the sync protocol and blinking playback for the whole room over a
    // gesture that was only ever about fullscreen.
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

    // Double clicking while working the scrubber must not fullscreen the page.
    fireEvent.doubleClick(container.querySelector('input[aria-label="Seek"]')!)

    expect(requestFullscreen).not.toHaveBeenCalled()
  })

  it('still answers the space bar after a control was clicked', () => {
    // Clicking a control leaves it focused, and space would press that button
    // again — reading as the shortcut being swallowed by the player's own bar.
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
    // Clicking the scrubber leaves it focused, and its native arrow step is
    // one second. The room shortcut must not lose to the control it sits on:
    // its preventDefault is what stops the slider from also stepping.
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
    // Unlike the scrubber, the slider's own arrow step is the volume control.
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

  it('shows the LIVE control only to viewers and seeks locally without publishing', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const syncState = { playing: true, positionMs: 60_000, rate: 1, serverTimeMs: 100_000 }
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const { rerender } = render(
      <Player room={room} isController videoRef={videoRef} send={send} t={t} syncState={syncState} serverOffsetMs={0} />,
    )

    // The controller defines the room position; LIVE would be meaningless.
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

    // [0,20] splits at the playhead; [50,70] is entirely ahead of it.
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
    // The real range input survives the rebuild, still viewer-locked.
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
  // The media element only holds the current region, rebased to zero; the
  // room speaks absolute time. These pin the mapping at the two edges the
  // player owns: what the scrubber promises, and what a seek reports.
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
    // Region-relative zero, plus the region's start, plus the five-second step.
    expect(send).toHaveBeenCalledWith('seek', { positionMs: 1_085_000 })
  })

  it('shows the clock as absolute time', () => {
    const videoRef = createRef<HTMLVideoElement>()
    const { container } = render(
      <Player room={offsetRoom} isController videoRef={videoRef} send={vi.fn()} t={t} />,
    )
    fireEvent.timeUpdate(videoRef.current!)
    // currentTime 0 in the element is 18 minutes into the room.
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
    // Mid-drag nothing goes on the wire; the thumb follows the finger.
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
    // The room is still preparing the region; a timeupdate far from the
    // target — the restored render that used to spawn the phantom second
    // seek — must not pull the thumb back.
    fireEvent.timeUpdate(videoRef.current!)
    expect(scrubber.value).toBe('1220')
  })

  it('parks a playing room on a cold seek and resumes when the region lands', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const playing = { playing: true, positionMs: 120_000, rate: 1, serverTimeMs: 100_000 }
    const { container, rerender } = render(
      <Player room={longRoom} isController videoRef={videoRef} send={send} t={t} syncState={playing} serverOffsetMs={0} />,
    )
    const video = videoRef.current!
    // The current region covers only the first 300s of the timeline; 1220 is
    // media the pipeline has not produced yet.
    Object.defineProperty(video, 'duration', { configurable: true, value: 300 })
    fireEvent.durationChange(video)
    const scrubber = container.querySelector('input[aria-label="Seek"]')! as HTMLInputElement
    fireEvent.pointerDown(scrubber)
    fireEvent.change(scrubber, { target: { value: '1220' } })
    fireEvent.pointerUp(scrubber)
    expect(send).toHaveBeenCalledWith('seek', { positionMs: 1_220_000 })
    expect(send).toHaveBeenCalledWith('pause', expect.objectContaining({ positionMs: 1_220_000 }))
    send.mockClear()
    // The new region publishing bumps mediaVersion; the room wakes up at the
    // parked target instead of wherever the clock would have walked to.
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
    expect(send).toHaveBeenCalledWith('play', expect.objectContaining({ positionMs: 1_220_000 }))
  })

  it('a play behind a cold seek resumes at the room\'s position, not the element\'s', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    // The room was sought to 1220s and paused there; the element still holds
    // the old region at 120s because the new one has not published yet.
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

  it('holds the element still and parks the play while no region covers the room', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    // Room parked at 1220s; the only region covers the first 300s.
    const regioned = { ...longRoom, mediaRegions: [{ n: 0, startMs: 0, producedMs: 300_000, growing: true }] }
    const parked = { playing: false, positionMs: 1_220_000, rate: 1, serverTimeMs: 100_000 }
    const { container, rerender } = render(
      <Player room={regioned} isController videoRef={videoRef} send={send} t={t} syncState={parked} serverOffsetMs={0} />,
    )
    // The wait is shown, not silently played through.
    expect(container.querySelector('.player-loading')).not.toBeNull()
    const video = videoRef.current!
    video.play = vi.fn(() => Promise.resolve())
    fireEvent.click(container.querySelector('button.is-play')! as HTMLButtonElement)
    // No play goes on the wire while nothing covers the target...
    expect(send).not.toHaveBeenCalledWith('play', expect.anything())
    // ...and the region landing resumes the room right at it.
    rerender(
      <Player
        room={{ ...regioned, mediaVersion: 1, mediaRegions: [{ n: 0, startMs: 0, producedMs: 300_000, growing: false }, { n: 1, startMs: 1_219_000, producedMs: 8_000, growing: true }] }}
        isController
        videoRef={videoRef}
        send={send}
        t={t}
        syncState={parked}
        serverOffsetMs={0}
      />,
    )
    expect(send).toHaveBeenCalledWith('play', expect.objectContaining({ positionMs: 1_220_000 }))
  })

  it('does not park when the target is already covered', () => {
    const send = vi.fn()
    const videoRef = createRef<HTMLVideoElement>()
    const playing = { playing: true, positionMs: 120_000, rate: 1, serverTimeMs: 100_000 }
    const { container } = render(
      <Player room={longRoom} isController videoRef={videoRef} send={send} t={t} syncState={playing} serverOffsetMs={0} />,
    )
    const video = videoRef.current!
    Object.defineProperty(video, 'duration', { configurable: true, value: 1_440 })
    fireEvent.durationChange(video)
    const scrubber = container.querySelector('input[aria-label="Seek"]')! as HTMLInputElement
    fireEvent.pointerDown(scrubber)
    fireEvent.change(scrubber, { target: { value: '1220' } })
    fireEvent.pointerUp(scrubber)
    expect(send).toHaveBeenCalledWith('seek', { positionMs: 1_220_000 })
    expect(send).not.toHaveBeenCalledWith('pause', expect.anything())
  })
})
