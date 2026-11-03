import { act, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Person, RoomActions, RoomViewModel } from '../room/model'
import { TvRoomView, type Playhead, type TvRoomKeys } from './TvRoomView'

const person = (id: string, name: string, extra: Partial<Person> = {}): Person => ({
  id, name, host: false, mic: true, cam: false, speaking: false, hostMuted: false, hostCamOff: false, ...extra,
})

function model(overrides: Partial<RoomViewModel> = {}): RoomViewModel {
  return {
    name: 'Sessão de sexta',
    link: 'juntos.lol/K7Q2M9XA',
    startedAt: Date.now(),
    joinMode: 'open',
    selfId: 'tv1',
    isHost: false,
    people: [person('giu', 'Giu', { host: true }), person('ana', 'Ana')],
    stages: [{ id: 'media', kind: 'media', title: 'Filme', ownerId: 'giu' }],
    spotlight: null,
    requests: [],
    knocks: [],
    removed: [],
    chat: [{ id: 'c1', authorId: 'ana', author: 'Ana', text: 'oi gente', at: Date.now() }],
    reactions: [],
    sources: [],
    actions: {} as RoomActions,
    slots: { renderVideo: () => null, renderStage: (stage) => <p>palco {stage.id}</p> },
    ...overrides,
  }
}

function setup(overrides: Partial<RoomViewModel> = {}, head: Playhead = { position: 30, duration: 600, paused: false }) {
  const keys = createRef<TvRoomKeys>()
  const onMedia = vi.fn()
  const onAudio = vi.fn()
  const onStop = vi.fn()
  const view = render(<TvRoomView vm={model(overrides)} playhead={() => head} onMedia={onMedia} onAudio={onAudio} onStop={onStop} keysRef={keys} />)
  return { keys, onMedia, onAudio, onStop, view }
}

const room = () => document.querySelector('[data-bar]')

describe('TvRoomView', () => {
  it('o palco enche a tela, sem fixar nem menus do site', () => {
    setup()
    expect(screen.getByText('palco media')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Fixar/ })).toBeNull()
  })

  it('OK apertado toca ou pausa', () => {
    const { keys, onMedia } = setup()
    act(() => { keys.current!.key('enter', false); keys.current!.enterUp() })
    expect(onMedia).toHaveBeenCalledWith('playPause')
  })

  it('OK segurado abre o som e não pausa', () => {
    vi.useFakeTimers()
    const { keys, onMedia, onAudio } = setup()
    act(() => { keys.current!.key('enter', false) })
    act(() => { vi.advanceTimersByTime(700) })
    act(() => { keys.current!.enterUp() })
    expect(onAudio).toHaveBeenCalled()
    expect(onMedia).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('← e → pulam dez segundos', () => {
    const { keys, onMedia } = setup()
    act(() => { keys.current!.key('left', false) })
    act(() => { keys.current!.key('right', false) })
    expect(onMedia.mock.calls).toEqual([['rewind'], ['forward']])
  })

  it('↑ traz a barra com o foco no play', async () => {
    const { keys } = setup()
    expect(room()).toBeNull()
    act(() => { keys.current!.key('up', false) })
    expect(room()).not.toBeNull()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pausar' }))
  })

  it('pausado, a barra fica', () => {
    setup({}, { position: 30, duration: 600, paused: true })
    expect(room()).not.toBeNull()
  })

  it('mensagem que chega aparece por cima, a antiga não', () => {
    const { view } = setup({ chat: [{ id: 'c0', authorId: 'ana', author: 'Ana', text: 'de antes', at: Date.now() - 60_000 }] })
    expect(screen.queryByText('de antes')).toBeNull()
    view.rerender(<TvRoomView vm={model({ chat: [{ id: 'c1', authorId: 'ana', author: 'Ana', text: 'oi gente', at: Date.now() + 10 }] })} playhead={() => null} onMedia={vi.fn()} onAudio={vi.fn()} onStop={vi.fn()} keysRef={createRef()} />)
    expect(screen.getByText('oi gente')).toBeInTheDocument()
  })

  it('sem palco, as pessoas enchem a tela', () => {
    setup({ stages: [] })
    expect(screen.getByText('Giu')).toBeInTheDocument()
    expect(screen.queryByText(/palco/)).toBeNull()
  })
})
