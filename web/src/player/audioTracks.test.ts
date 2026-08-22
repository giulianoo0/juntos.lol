import { describe, expect, it } from 'vitest'

import { audioTrackLabel, languageLabel } from './audioTracks'

describe('languageLabel', () => {
  it('names three-letter codes in the reader locale', () => {
    expect(languageLabel('por', 'pt-BR')).toBe('Português')
    expect(languageLabel('jpn', 'pt-BR')).toBe('Japonês')
    expect(languageLabel('por', 'en')).toBe('Portuguese')
  })

  it('names both halves of a doubled ISO 639-2 code the same way', () => {
    // The same dub arrives as "ger" from one release and "deu" from the next,
    // and a menu that names one and not the other looks broken.
    expect(languageLabel('ger', 'en')).toBe(languageLabel('deu', 'en'))
    expect(languageLabel('fre', 'en')).toBe(languageLabel('fra', 'en'))
    expect(languageLabel('deu', 'pt-BR')).toBe('Alemão')
  })

  it('accepts two-letter codes and a region suffix', () => {
    expect(languageLabel('pt', 'pt-BR')).toBe('Português')
    expect(languageLabel('pt-BR', 'en')).toBe('Brazilian Portuguese')
  })

  it('gives up rather than echoing an unnameable tag', () => {
    expect(languageLabel('und', 'en')).toBeNull()
    expect(languageLabel('', 'en')).toBeNull()
    expect(languageLabel('zzz', 'en')).toBeNull()
  })
})

describe('audioTrackLabel', () => {
  it('drops ffmpeg placeholder names in favour of the language', () => {
    // What the pipeline actually publishes: var_stream_map cannot carry a name
    // with spaces, so ffmpeg numbers the renditions itself.
    expect(audioTrackLabel({ name: 'audio_6', lang: 'por' }, 'pt-BR', 6)).toBe('Português')
    expect(audioTrackLabel({ name: 'audio_0', lang: 'jpn' }, 'pt-BR', 0)).toBe('Japonês')
  })

  it('keeps a name the encoder did not invent', () => {
    expect(audioTrackLabel({ name: 'Comentários', lang: 'por' }, 'pt-BR', 1)).toBe('Comentários')
  })

  it('falls back to the raw code, then to the position', () => {
    expect(audioTrackLabel({ name: 'audio_1', lang: 'zzz' }, 'en', 1)).toBe('zzz')
    expect(audioTrackLabel({ name: 'audio_2' }, 'en', 2)).toBe('3')
    expect(audioTrackLabel({}, 'en', 0)).toBe('1')
  })
})
