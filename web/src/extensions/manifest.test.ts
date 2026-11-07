import { describe, expect, it } from 'vitest'
import table from '../../../extensions/manifest-cases.json'
import { parseManifest } from './registry'

type Obj = Record<string, unknown>
interface Cases {
  base: Obj
  accept: { case: string; set?: Obj; unset?: string[]; expect?: Obj }[]
  refuse: { case: string; set?: Obj; replace?: unknown }[]
}
// The one table of what a juntos.json may be; Go and the extension host read it too.
const cases = table as unknown as Cases

function withCase(set: Obj = {}, unset: string[] = []): Obj {
  const m: Obj = { ...cases.base, ...set }
  for (const key of unset) delete m[key]
  return m
}

describe('parseManifest, pela tabela comum', () => {
  it.each(cases.accept)('aceita $case', (c) => {
    const m = parseManifest(withCase(c.set, c.unset))
    expect(m).not.toBeNull()
    for (const [key, want] of Object.entries(c.expect ?? {})) {
      expect((m as unknown as Obj)[key] ?? null, key).toEqual(want)
    }
  })

  it.each(cases.refuse)('recusa $case', (c) => {
    expect(parseManifest('replace' in c ? c.replace : withCase(c.set))).toBeNull()
  })
})
