/**
 * A assinatura do juntos.lol em caligrafia monolinha: traço de 12, altura de
 * x de 36 (y -42 a -6), hastes subindo a -68. Cada letra é um ou dois traços
 * com começo e fim próprios — é isso que deixa a escrita da abertura
 * (ui/Splash.tsx) parecer uma caneta em vez de um preenchimento revelado.
 *
 * Cópia fiel de ../../../logos/juntos-logo.svg — os dois têm que bater.
 */
export interface Stroke {
  id: string
  d: string
  joined?: boolean
}

const S_CX = 266

export const STROKE_WIDTH = 12

export const WORDMARK_STROKES: Stroke[] = [
  { id: 'j', d: 'M 12 -42 L 12 0 A 12 12 0 0 1 0 12' },
  { id: 'u1', d: 'M 34 -42 L 34 -18 A 18 18 0 0 0 70 -18' },
  { id: 'u2', d: 'M 70 -42 L 70 -6', joined: true },
  { id: 'n1', d: 'M 92 -42 L 92 -6' },
  { id: 'n2', d: 'M 92 -24 A 18 18 0 0 1 128 -24 L 128 -6', joined: true },
  { id: 't1', d: 'M 161 -62 L 161 -6' },
  { id: 't2', d: 'M 150 -42 L 172 -42', joined: true },
  { id: 'o1', d: 'M 213 -43.5 A 19 19.5 0 1 1 212.98 -43.5' },
  { id: 's', d: `M ${S_CX + 11.93} -37.1 A 12 10.5 0 1 0 ${S_CX} -25.5 A 12 10.5 0 1 1 ${S_CX - 11.12} -11.07` },
  { id: 'l1', d: 'M 336 -68 L 336 -6' },
  { id: 'o2', d: 'M 377 -43.5 A 19 19.5 0 1 1 376.98 -43.5' },
  { id: 'l2', d: 'M 418 -68 L 418 -6', joined: true },
]

export const WORDMARK_DOT = { cx: 12, cy: -58, r: 6.5 }

export const WORDMARK_PLAY = 'M 299 -33 L 313 -24 L 299 -15 Z'

export const WORDMARK_VIEWBOX = '-8 -80 440 108'

export const CORAL = '#FF7A45'

export const MARK_STEM = 'M 300 176 L 300 306 A 96 96 0 0 1 204 402'
export const MARK_PLAY = 'M 282 58 L 324 81 L 282 104 Z'
export const MARK_VIEWBOX = '150 40 220 424'
