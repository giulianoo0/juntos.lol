import { describe, expect, it } from 'vitest'
import { initialSession, sessionReducer, type TvSession } from './session'

const account = { id: 9, nickname: 'Giuli', avatar: 'fox.bowtie' }
const device = { id: 'd1', name: 'Sala' }
const waiting: TvSession = { screen: 'waiting', token: 't1', account, device }
const inRoom: TvSession = { ...waiting, screen: 'room', roomId: 'R1', ticket: 'k1' }

describe('sessionReducer', () => {
  it('sem token começa pareando; com token, confere a conta', () => {
    expect(initialSession(null)).toEqual({ screen: 'pairing' })
    expect(initialSession('t1')).toEqual({ screen: 'checking', token: 't1' })
  })

  it('pareamento → espera → sala → espera', () => {
    let state = sessionReducer({ screen: 'pairing' }, { type: 'linked', token: 't1', account, device })
    expect(state).toEqual(waiting)
    state = sessionReducer(state, { type: 'cast', roomId: 'R1', ticket: 'k1' })
    expect(state).toEqual(inRoom)
    state = sessionReducer(state, { type: 'stop' })
    expect(state).toEqual(waiting)
  })

  it('a conta conferida leva à espera', () => {
    expect(sessionReducer({ screen: 'checking', token: 't1' }, { type: 'me', account, device })).toEqual(waiting)
  })

  it('um cast novo troca de sala sem passar pela espera', () => {
    expect(sessionReducer(inRoom, { type: 'cast', roomId: 'R2', ticket: 'k2' })).toEqual({ ...inRoom, roomId: 'R2', ticket: 'k2' })
  })

  it('a sala que fecha volta à espera', () => {
    expect(sessionReducer(inRoom, { type: 'roomClosed', roomId: 'R1' })).toEqual(waiting)
  })

  it('o fim de uma sala que já foi trocada não tira a TV da nova', () => {
    const next = { ...inRoom, roomId: 'R2' }
    expect(sessionReducer(next, { type: 'roomClosed', roomId: 'R1' })).toBe(next)
  })

  it.each<[string, TvSession]>([
    ['na espera', waiting],
    ['na sala', inRoom],
    ['conferindo', { screen: 'checking', token: 't1' }],
  ])('revogada %s volta ao pareamento', (_, state) => {
    expect(sessionReducer(state, { type: 'revoked' })).toEqual({ screen: 'pairing' })
  })

  it('cast antes de saber a conta é ignorado', () => {
    const checking: TvSession = { screen: 'checking', token: 't1' }
    expect(sessionReducer(checking, { type: 'cast', roomId: 'R1', ticket: 'k1' })).toBe(checking)
    expect(sessionReducer({ screen: 'pairing' }, { type: 'cast', roomId: 'R1', ticket: 'k1' })).toEqual({ screen: 'pairing' })
  })
})
