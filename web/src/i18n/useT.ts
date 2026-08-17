import { useMemo, useState } from 'react'
import { en } from './en'
import { ptBR } from './pt-BR'

export type Language = 'en' | 'pt-BR'
export type Translator = ((key: string) => string) & {
  language: Language
  setLanguage: (language: Language) => void
}

const dictionaries: Record<Language, Record<string, string>> = { en, 'pt-BR': ptBR }

export function normalizeLanguage(language: string): Language {
  return language.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en'
}

export function translate(language: string, key: string): string {
  const dictionary = dictionaries[normalizeLanguage(language)] ?? en
  return dictionary[key] ?? en[key] ?? key
}

export function useT(): Translator {
  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem('ss.language')
    return saved === 'pt-BR' || saved === 'en' ? saved : normalizeLanguage(navigator.language)
  })
  return useMemo(() => {
    const translator = ((key: string) => translate(language, key)) as Translator
    translator.language = language
    translator.setLanguage = (nextLanguage) => {
      localStorage.setItem('ss.language', nextLanguage)
      setLanguageState(nextLanguage)
    }
    return translator
  }, [language])
}
