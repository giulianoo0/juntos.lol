import { describe, expect, it } from 'vitest'
import { en } from './en'
import { ptBR } from './pt-BR'
import { translate } from './useT'

describe('translate', () => {
  it('translates and falls back to english', () => {
    expect(translate('en', 'room.badPassword')).toBe('Wrong password')
    expect(translate('pt-BR', 'room.badPassword')).toBe('Senha errada')
    expect(translate('fr', 'room.badPassword')).toBe('Wrong password')
  })

  it('has no em dash in any string', () => {
    for (const dictionary of [en, ptBR]) {
      for (const value of Object.values(dictionary)) expect(value).not.toContain('—')
    }
  })
})
