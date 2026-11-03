import { describe, expect, it } from 'vitest'
import { codeFromQr, formatCodeInput, linkCodeFrom } from './code'

describe('linkCodeFrom', () => {
  it.each([
    ['ABCDEFGH', 'ABCDEFGH'],
    ['ABCD-EFGH', 'ABCDEFGH'],
    [' abcd-efgh ', 'ABCDEFGH'],
    ['ABCD-EFG', null],
    ['ABCD-EFGHJ', null],
    ['ABCD_EF!H', null],
  ])('%j vira %j', (input, code) => {
    expect(linkCodeFrom(input)).toBe(code)
  })
})

describe('formatCodeInput', () => {
  it.each([
    ['abc', 'ABC'],
    ['abcd', 'ABCD'],
    ['abcde', 'ABCD-E'],
    ['ABCD-EFGH', 'ABCD-EFGH'],
    ['abcd efgh', 'ABCD-EFGH'],
    ['ABCDEFGHIJ', 'ABCD-EFGH'],
    ['ab-', 'AB'],
  ])('%j aparece como %j', (typed, shown) => {
    expect(formatCodeInput(typed)).toBe(shown)
  })
})

describe('codeFromQr', () => {
  it.each([
    ['https://juntos.lol/tv/vincular?c=ABCDEFGH', 'ABCDEFGH'],
    ['https://juntos.lol/tv/vincular?c=abcd-efgh', 'ABCDEFGH'],
    ['http://localhost:5173/tv/vincular?x=1&c=K7Q2M9XA', 'K7Q2M9XA'],
    ['ABCD-EFGH', 'ABCDEFGH'],
    ['https://juntos.lol/tv/vincular', null],
    ['https://juntos.lol/room/K7Q2M9XA', null],
    ['https://juntos.lol/tv/vincular?c=curto', null],
    ['qualquer coisa', null],
  ])('%j dá %j', (text, code) => {
    expect(codeFromQr(text)).toBe(code)
  })
})
