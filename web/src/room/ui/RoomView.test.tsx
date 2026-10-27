import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { EntryViewModel, Person, RoomActions, RoomViewModel } from '../model'
import { EntryScreen } from './Entry'
import { RoomView } from './RoomView'

const person = (id: string, name: string, extra: Partial<Person> = {}): Person => ({
  id, name, host: false, mic: true, cam: false, speaking: false, hostMuted: false, hostCamOff: false, ...extra,
})

function model(overrides: Partial<RoomViewModel> = {}): RoomViewModel {
  const actions = Object.fromEntries([
    'setMic', 'setCam', 'share', 'react', 'sendChat', 'leave', 'copyLink', 'spotlight', 'answerRequest',
    'admit', 'deny', 'hostMute', 'hostCamOff', 'kick', 'makeHost', 'setAccess', 'closeStage',
  ].map((name) => [name, vi.fn()])) as unknown as RoomActions
  return {
    name: 'Sessão de sexta',
    link: 'juntos.lol/K7Q2M9XA',
    startedAt: Date.now(),
    joinMode: 'open',
    selfId: 'giu',
    isHost: true,
    people: [person('giu', 'Giu', { host: true }), person('ana', 'Ana')],
    stages: [],
    spotlight: null,
    requests: [{ id: 'r1', memberId: 'ana', name: 'Ana', kind: 'screen' }],
    knocks: [],
    chat: [],
    reactions: [],
    sources: ['screen', 'file', 'torrent'],
    actions,
    slots: {
      renderVideo: () => null,
      renderStage: () => null,
      renderShare: (source) => (source === 'torrent' ? <p>picker do torrent</p> : null),
    },
    ...overrides,
  }
}

describe('RoomView', () => {
  it('lets the host answer a guest asking for the screen', () => {
    const vm = model()
    render(<RoomView vm={vm} />)
    fireEvent.click(screen.getByRole('button', { name: 'Permitir' }))
    expect(vm.actions.answerRequest).toHaveBeenCalledWith('r1', true)
  })

  it('shows a guest no requests to answer', () => {
    render(<RoomView vm={model({ isHost: false, selfId: 'ana' })} />)
    expect(screen.queryByRole('button', { name: 'Permitir' })).toBeNull()
  })

  it('opens the picker a share source needs, after telling the room', async () => {
    const vm = model()
    render(<RoomView vm={vm} />)
    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Torrent' }))
    expect(vm.actions.share).toHaveBeenCalledWith('torrent')
    expect(await screen.findByText('picker do torrent')).toBeInTheDocument()
  })

  it('sends what was typed, trimmed, and empties the composer', () => {
    const vm = model()
    render(<RoomView vm={vm} />)
    const field = screen.getByRole('textbox', { name: 'Mensagem' })
    fireEvent.change(field, { target: { value: '  bora?  ' } })
    fireEvent.submit(field)
    expect(vm.actions.sendChat).toHaveBeenCalledWith('bora?')
    expect(field).toHaveValue('')
  })

  it('heads a run of messages with the name once', () => {
    const at = Date.now()
    render(<RoomView vm={model({ chat: [
      { id: '1', authorId: 'ana', author: 'Ana', text: 'oi', at },
      { id: '2', authorId: 'ana', author: 'Ana', text: 'tudo bem?', at },
    ] })} />)
    const chat = screen.getByText('oi').closest('[data-message-id]')?.parentElement as HTMLElement
    expect(within(chat).getAllByText('Ana')).toHaveLength(1)
  })

  it('turns the microphone off from the dock', () => {
    const vm = model()
    render(<RoomView vm={vm} />)
    fireEvent.click(screen.getByRole('button', { name: 'Microfone' }))
    expect(vm.actions.setMic).toHaveBeenCalledWith(false)
  })

  it('brings a pinned person to the focus, and lets them go', () => {
    render(<RoomView vm={model({ requests: [] })} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Fixar' })[1] as HTMLElement)
    expect(screen.getByRole('button', { name: 'Desafixar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fixar: Giu' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Desafixar' }))
    expect(screen.queryByRole('button', { name: 'Desafixar' })).toBeNull()
  })
})

describe('RoomView reactions', () => {
  it('reacts with the Apple picture picked in the dock', async () => {
    const vm = model()
    render(<RoomView vm={vm} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reações' }))
    const laugh = await screen.findByRole('menuitem', { name: '😂' })
    expect(laugh.querySelector('img')).toHaveAttribute('src', '/emoji/1f602.png')
    fireEvent.click(laugh)
    expect(vm.actions.react).toHaveBeenCalledWith('😂')
  })

  it('floats a fresh reaction over the tile of who sent it, and not an old one', () => {
    const vm = model({ requests: [], reactions: [{ id: 'old', memberId: 'ana', emoji: '🔥', at: Date.now() - 60_000 }] })
    const { container, rerender } = render(<RoomView vm={vm} />)
    expect(container.querySelector('[data-reaction-burst]')).toBeNull()

    rerender(<RoomView vm={{ ...vm, reactions: [...vm.reactions, { id: 'new', memberId: 'ana', emoji: '😂', at: Date.now() }] }} />)

    const bursts = [...container.querySelectorAll('[data-reaction-burst]')]
    expect(bursts.map((burst) => burst.getAttribute('src'))).toEqual(['/emoji/1f602.png'])
    expect(bursts[0]?.closest('[data-member]')?.getAttribute('data-member')).toBe('ana')
    expect(container.querySelector('[data-member="ana"]')).toHaveAttribute('data-reaction', '😂')
  })
})

describe('RoomView beside a stage', () => {
  const media = { id: 'media', kind: 'media' as const, title: 'Duna', ownerId: 'giu' }

  it('stands the people in the column while the panel is shut, and under the stage when it opens', () => {
    const { container } = render(<RoomView vm={model({ requests: [], stages: [media] })} />)
    const people = () => container.querySelector('[data-arrange]')?.getAttribute('data-arrange')
    expect(people()).toBe('strip')
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(people()).toBe('column')
  })
})

describe('EntryScreen', () => {
  const entry = (overrides: Partial<EntryViewModel> = {}): EntryViewModel => ({
    name: 'Sessão de sexta',
    joinMode: 'password',
    present: ['Giu'],
    presentCount: 1,
    nickname: 'Fê',
    mic: true,
    cam: false,
    busy: false,
    setMic: vi.fn(),
    setCam: vi.fn(),
    join: vi.fn(),
    renderPreview: () => null,
    ...overrides,
  })

  it('waits for the password before letting you in', () => {
    const vm = entry()
    render(<EntryScreen vm={vm} />)
    const join = screen.getByRole('button', { name: 'Entrar' })
    expect(join).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Senha da sala'), { target: { value: 'pipoca' } })
    fireEvent.click(join)
    expect(vm.join).toHaveBeenCalledWith({ nickname: 'Fê', password: 'pipoca' })
  })

  it('asks no password of an open room', () => {
    render(<EntryScreen vm={entry({ joinMode: 'open' })} />)
    expect(screen.queryByLabelText('Senha da sala')).toBeNull()
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled()
  })
})
