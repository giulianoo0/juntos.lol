import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Person, RoomActions, RoomViewModel } from '../room/model'
import { TvRoomView } from './TvRoomView'

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

describe('TvRoomView', () => {
  it('põe o palco em foco e as pessoas ao lado', () => {
    render(<TvRoomView vm={model()} onAudio={vi.fn()} />)
    expect(screen.getByText('palco media')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fixar: Giu' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fixar: Ana' })).toBeInTheDocument()
  })

  it('mostra o chat só para ler', () => {
    render(<TvRoomView vm={model()} onAudio={vi.fn()} />)
    expect(screen.getByText('oi gente')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('o chat recolhe e volta', () => {
    render(<TvRoomView vm={model()} onAudio={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(screen.queryByText('oi gente')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(screen.getByText('oi gente')).toBeInTheDocument()
  })

  it('o botão de áudio abre o painel da TV', () => {
    const onAudio = vi.fn()
    render(<TvRoomView vm={model()} onAudio={onAudio} />)
    fireEvent.click(screen.getByRole('button', { name: 'Áudio' }))
    expect(onAudio).toHaveBeenCalled()
  })

  it('sem palco, as pessoas enchem a tela', () => {
    render(<TvRoomView vm={model({ stages: [] })} onAudio={vi.fn()} />)
    expect(screen.getByText('Giu')).toBeInTheDocument()
    expect(screen.queryByText(/palco/)).toBeNull()
  })
})
