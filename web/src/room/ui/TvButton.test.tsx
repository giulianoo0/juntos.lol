import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Person, RoomActions, RoomTv, RoomTvDevice, RoomViewModel } from '../model'
import { RoomView } from './RoomView'

const person = (id: string, name: string, extra: Partial<Person> = {}): Person => ({
  id, name, host: false, mic: true, cam: false, speaking: false, hostMuted: false, hostCamOff: false, ...extra,
})

const tvDevice = (id: string, name: string, extra: Partial<RoomTvDevice> = {}): RoomTvDevice => ({
  id, name, online: true, here: false, mix: { media: 1, people: {} }, ...extra,
})

function fakeTv(overrides: Partial<RoomTv> = {}): RoomTv {
  return {
    signedIn: true,
    loginUrl: '/api/auth/discord?next=%2Froom%2FK7Q2M9XA',
    devices: [],
    watch: vi.fn(),
    cast: vi.fn(async () => undefined),
    stop: vi.fn(),
    setMix: vi.fn(),
    link: vi.fn(async () => undefined),
    ...overrides,
  }
}

function renderRoom(tv: RoomTv) {
  const actions = new Proxy({}, { get: () => vi.fn() }) as RoomActions
  const vm: RoomViewModel = {
    name: 'Sessão de sexta',
    link: 'juntos.lol/K7Q2M9XA',
    startedAt: Date.now(),
    joinMode: 'open',
    selfId: 'giu',
    isHost: true,
    people: [person('giu', 'Giu', { host: true }), person('ana', 'Ana')],
    stages: [],
    spotlight: null,
    requests: [],
    knocks: [],
    removed: [],
    chat: [],
    reactions: [],
    sources: ['file'],
    tv,
    actions,
    slots: { renderVideo: () => null, renderStage: () => null },
  }
  render(<RoomView vm={vm} />)
}

const mirror = () => fireEvent.click(screen.getByRole('button', { name: 'Espelhar na TV' }))

describe('Espelhar na TV', () => {
  beforeEach(() => localStorage.setItem('ss.language', 'pt-BR'))

  it('sem conta, pede para entrar com o Discord', async () => {
    renderRoom(fakeTv({ signedIn: false, devices: null }))
    mirror()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('link', { name: 'Entrar com Discord' })).toHaveAttribute('href', '/api/auth/discord?next=%2Froom%2FK7Q2M9XA')
  })

  it('sem TV, abre o diálogo de vincular', async () => {
    renderRoom(fakeTv({ devices: [] }))
    mirror()
    expect(await screen.findByRole('textbox', { name: 'Código da TV' })).toBeInTheDocument()
  })

  it('com TVs, espelha a sala na escolhida e não deixa escolher a desligada', async () => {
    const tv = fakeTv({ devices: [tvDevice('tv1', 'TV da sala'), tvDevice('tv2', 'TV do quarto', { online: false })] })
    renderRoom(tv)
    mirror()
    expect(tv.watch).toHaveBeenCalledWith(true)
    expect(await screen.findByRole('menuitem', { name: 'TV do quarto' })).toBeDisabled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'TV da sala' }))
    expect(tv.cast).toHaveBeenCalledWith('tv1')
  })

  describe('espelhando', () => {
    const casting = (mix = { media: 0.8, people: {} as Record<string, number> }) =>
      fakeTv({ devices: [tvDevice('tv1', 'TV da sala', { here: true, mix })] })

    it('mostra o dono em 0 e os outros em 100% quando o mix não fala deles', async () => {
      renderRoom(casting())
      mirror()
      expect(await screen.findByRole('slider', { name: 'Volume de Giu' })).toHaveValue('0')
      expect(screen.getByRole('slider', { name: 'Volume de Ana' })).toHaveValue('1')
      expect(screen.getByRole('slider', { name: 'Volume da mídia' })).toHaveValue('0.8')
    })

    it('mudar alguém grava o mix com o dono ainda em 0', async () => {
      const tv = casting()
      renderRoom(tv)
      mirror()
      fireEvent.change(await screen.findByRole('slider', { name: 'Volume de Ana' }), { target: { value: '0.5' } })
      expect(tv.setMix).toHaveBeenLastCalledWith('tv1', { media: 0.8, people: { giu: 0, ana: 0.5 } })
    })

    it('silencia alguém', async () => {
      const tv = casting({ media: 1, people: { ana: 0.6 } })
      renderRoom(tv)
      mirror()
      fireEvent.click(await screen.findByRole('button', { name: 'Silenciar Ana na TV' }))
      expect(tv.setMix).toHaveBeenLastCalledWith('tv1', { media: 1, people: { giu: 0, ana: 0 } })
    })

    it('"Só a mídia" cala todo mundo', async () => {
      const tv = casting({ media: 1, people: { giu: 0.4, ana: 0.7 } })
      renderRoom(tv)
      mirror()
      fireEvent.click(await screen.findByRole('button', { name: 'Só a mídia' }))
      expect(tv.setMix).toHaveBeenLastCalledWith('tv1', { media: 1, people: { giu: 0, ana: 0 } })
    })

    it('para de espelhar', async () => {
      const tv = casting()
      renderRoom(tv)
      mirror()
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Parar de espelhar' }))
      expect(tv.stop).toHaveBeenCalledWith('tv1')
    })
  })
})
