import { describe, expect, it } from 'vitest'
import { en } from './en'
import { ptBR } from './pt-BR'
import { translate } from './useT'

describe('translate', () => {
  it('translates and falls back to english', () => {
    expect(translate('en', 'home.continue')).toBe('Create room')
    expect(translate('pt-BR', 'home.continue')).toBe('Criar sala')
    expect(translate('fr', 'home.continue')).toBe('Create room')
  })

  it('has no em dash in any string', () => {
    for (const dictionary of [en, ptBR]) {
      for (const value of Object.values(dictionary)) expect(value).not.toContain('—')
    }
  })
})
