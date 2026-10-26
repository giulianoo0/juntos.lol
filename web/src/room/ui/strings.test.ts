import { describe, expect, it } from 'vitest'
import { presentLine, type RoomStrings } from './strings'

const strings = {
  hereOne: '{names} está aqui',
  hereMany: '{names} estão aqui',
  andMore: '{names} e mais {n}',
  and: '{a} e {b}',
  nobody: 'Ninguém ainda',
} as RoomStrings

describe('presentLine', () => {
  it('names one person alone', () => {
    expect(presentLine(strings, ['Giu'], 1)).toBe('Giu está aqui')
  })

  it('joins the last name with "e"', () => {
    expect(presentLine(strings, ['Giu', 'Ana', 'Bruno'], 3)).toBe('Giu, Ana e Bruno estão aqui')
  })

  it('counts who is not named', () => {
    expect(presentLine(strings, ['Giu', 'Ana', 'Bruno', 'Caio', 'Duda'], 6)).toBe('Giu, Ana, Bruno e mais 3 estão aqui')
  })

  it('says when the room is empty', () => {
    expect(presentLine(strings, [], 0)).toBe('Ninguém ainda')
  })
})
