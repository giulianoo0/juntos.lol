export type Hue = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

/** A person's colour (`--hue-N`), picked by their id: the same one in the
    grid, the list and the chat, for as long as they keep that id. */
export function hueOf(id: string): Hue {
  let hash = 2166136261
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  // FNV's low bits barely move between ids that differ in one character.
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  return (((hash >>> 0) % 8) + 1) as Hue
}

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter('pt-BR', { granularity: 'grapheme' })
  : null

/** What an avatar shows: the name's first character, whole. */
export function initialOf(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const first = graphemes ? graphemes.segment(trimmed)[Symbol.iterator]().next().value?.segment : Array.from(trimmed)[0]
  return (first ?? '?').toLocaleUpperCase('pt-BR')
}
