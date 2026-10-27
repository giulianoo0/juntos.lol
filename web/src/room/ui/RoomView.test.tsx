import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(laugh.querySelector('img')).toHaveAttribute('src', '/emoji/1f602.png?v=2')
    fireEvent.click(laugh)
    expect(vm.actions.react).toHaveBeenCalledWith('😂')
  })

  it('floats a fresh reaction over the tile of who sent it, and not an old one', () => {
    const vm = model({ requests: [], reactions: [{ id: 'old', memberId: 'ana', emoji: '🔥', at: Date.now() - 60_000 }] })
    const { container, rerender } = render(<RoomView vm={vm} />)
    expect(container.querySelector('[data-reaction-burst]')).toBeNull()

    rerender(<RoomView vm={{ ...vm, reactions: [...vm.reactions, { id: 'new', memberId: 'ana', emoji: '😂', at: Date.now() }] }} />)

    const bursts = [...container.querySelectorAll('[data-reaction-burst]')]
    expect(bursts.map((burst) => burst.getAttribute('src'))).toEqual(['/emoji/1f602.png?v=2'])
    expect(bursts[0]?.closest('[data-member]')?.getAttribute('data-member')).toBe('ana')
    expect(container.querySelector('[data-member="ana"]')).toHaveAttribute('data-reaction', '😂')
  })
})

describe('RoomView faces', () => {
  afterEach(() => vi.useRealTimers())
  const face = (container: HTMLElement, id: string) => container.querySelector(`[data-member="${id}"] svg[data-kind]`)

  it('draws someone without a camera as their mascot, and a default one for who has none', () => {
    const { container } = render(<RoomView vm={model({ requests: [], people: [person('giu', 'Giu', { avatar: 'cat-preto.crown' }), person('ana', 'Ana')] })} />)
    expect(face(container, 'giu')).toHaveAttribute('data-kind', 'cat')
    expect(face(container, 'giu')).toHaveAttribute('data-accessory', 'crown')
    expect(face(container, 'ana')).not.toBeNull()
  })

  it('speaks while its person speaks', () => {
    const { container } = render(<RoomView vm={model({ requests: [], people: [person('giu', 'Giu', { speaking: true }), person('ana', 'Ana')] })} />)
    expect(face(container, 'giu')).toHaveAttribute('data-expression', 'speaking')
    expect(face(container, 'ana')).toHaveAttribute('data-expression', 'idle')
  })

  it('cheers for a while when its person laughs, and wonders at a gasp', () => {
    vi.useFakeTimers()
    const vm = model({ requests: [] })
    const { container, rerender } = render(<RoomView vm={vm} />)
    rerender(<RoomView vm={{ ...vm, reactions: [{ id: 'r1', memberId: 'ana', emoji: '😂', at: Date.now() }] }} />)
    expect(face(container, 'ana')).toHaveAttribute('data-expression', 'happy')
    act(() => { vi.advanceTimersByTime(1_600) })
    expect(face(container, 'ana')).toHaveAttribute('data-expression', 'idle')

    rerender(<RoomView vm={{ ...vm, reactions: [{ id: 'r2', memberId: 'ana', emoji: '😮', at: Date.now() }] }} />)
    expect(face(container, 'ana')).toHaveAttribute('data-expression', 'thinking')
  })

  it('puts the account number beside the name of who signed in', () => {
    const { container } = render(<RoomView vm={model({ requests: [], people: [person('giu', 'Giu', { accountId: 128 }), person('ana', 'Ana')] })} />)
    expect(container.querySelector('[data-member="giu"]')).toHaveTextContent('#128')
    expect(container.querySelector('[data-member="ana"]')).not.toHaveTextContent('#')
  })

  it('shows the mascot, held still, beside a chat message and in the people list', () => {
    const vm = model({ requests: [], people: [person('giu', 'Giu'), person('ana', 'Ana', { avatar: 'owl' })], chat: [{ id: '1', authorId: 'ana', author: 'Ana', text: 'oi', at: Date.now() }] })
    render(<RoomView vm={vm} />)
    const message = screen.getByText('oi').closest('[data-message-id]') as HTMLElement
    expect(message.querySelector('svg[data-kind="owl"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /Pessoas/ }))
    const list = screen.getByRole('list', { name: 'Pessoas' })
    expect(list.querySelector('svg[data-kind="owl"]')).not.toBeNull()
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
    avatar: 'fox.bowtie',
    setAvatar: vi.fn(),
    account: null,
    loginUrl: '/api/auth/discord?next=%2Froom%2Fr1',
    ...overrides,
  })

  it('stars your mascot and changes it from the picker', () => {
    const vm = entry({ joinMode: 'open' })
    const { container } = render(<EntryScreen vm={vm} />)
    expect(container.querySelector('[data-hero] svg[data-kind]')).toHaveAttribute('data-kind', 'fox')
    fireEvent.click(screen.getByRole('radio', { name: 'Gato' }))
    expect(vm.setAvatar).toHaveBeenCalledWith('cat.bowtie')
    expect(container.querySelector('[data-hero] svg[data-kind]')).toHaveAttribute('data-kind', 'cat')
    expect(container.querySelector('[data-hero] svg[data-kind]')).toHaveAttribute('data-expression', 'happy')
    fireEvent.click(screen.getByRole('radio', { name: 'Coroa' }))
    expect(vm.setAvatar).toHaveBeenLastCalledWith('cat.crown')
  })

  it('offers Discord to who is not signed in, and shows the number to who is', () => {
    const { rerender } = render(<EntryScreen vm={entry({ joinMode: 'open' })} />)
    expect(screen.getByRole('link', { name: /Discord/ })).toHaveAttribute('href', '/api/auth/discord?next=%2Froom%2Fr1')
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled()
    rerender(<EntryScreen vm={entry({ joinMode: 'open', account: { id: 7 } })} />)
    expect(screen.queryByRole('link', { name: /Discord/ })).toBeNull()
    expect(screen.getByText('#7')).toBeInTheDocument()
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
