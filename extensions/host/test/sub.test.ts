import { describe, expect, it } from 'vitest'
import { subFor } from '../src/sub'

describe('subFor', () => {
  it('bate com o vetor fixo compartilhado com o Go', async () => {
    expect(await subFor('exemplo')).toBe('lczfxd2q74zxknb5')
  })

  it('gera 16 caracteres do alfabeto base32 minúsculo', async () => {
    expect(await subFor('outra-extensao')).toMatch(/^[a-z2-7]{16}$/)
  })
})
