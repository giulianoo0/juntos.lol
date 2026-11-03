import { describe, expect, it } from 'vitest'
import { DEFAULT_MIX, memberVolumes, onlyMedia, ownerMemberId, withPerson } from './mix'

describe('ownerMemberId', () => {
  it('é a pessoa da conta da TV marcada com tv', () => {
    const members = [
      { id: 'm1', accountId: 7 },
      { id: 'm2', accountId: 9, tv: true },
      { id: 'm3', accountId: 9 },
    ]
    expect(ownerMemberId(members, 9)).toBe('m2')
  })

  it('sem a marca, fica com a pessoa da mesma conta', () => {
    expect(ownerMemberId([{ id: 'm1' }, { id: 'm3', accountId: 9 }], 9)).toBe('m3')
  })

  it('a conta fora da sala não tem dono', () => {
    expect(ownerMemberId([{ id: 'm1', accountId: 7 }], 9)).toBeNull()
  })
})

describe('memberVolumes', () => {
  it('o dono começa em 0 e os outros em 1', () => {
    expect(memberVolumes(DEFAULT_MIX, ['m1', 'm2'], 'm2')).toEqual({ m1: 1, m2: 0 })
  })

  it('o dono ouvido de propósito segue o mix', () => {
    expect(memberVolumes({ media: 1, people: { m2: 0.5 } }, ['m1', 'm2'], 'm2')).toEqual({ m1: 1, m2: 0.5 })
  })

  it('aplica o volume de cada pessoa e limita entre 0 e 1', () => {
    expect(memberVolumes({ media: 1, people: { m1: 0.3, m3: 4 } }, ['m1', 'm3'], null)).toEqual({ m1: 0.3, m3: 1 })
  })
})

describe('mudanças no mix', () => {
  it('"Só a mídia" põe todo mundo em 0 e mantém a mídia', () => {
    expect(onlyMedia({ media: 0.8, people: { m1: 1 } }, ['m1', 'm2'])).toEqual({ media: 0.8, people: { m1: 0, m2: 0 } })
  })

  it('muda uma pessoa sem mexer nas outras', () => {
    expect(withPerson({ media: 1, people: { m1: 0.2 } }, 'm2', 0.6)).toEqual({ media: 1, people: { m1: 0.2, m2: 0.6 } })
  })
})
