import { describe, expect, it } from 'vitest'
import { hostAllowed, parseManifest } from '../src/manifest'
import table from '../../manifest-cases.json'

type Obj = Record<string, unknown>
interface Cases {
  base: Obj
  accept: { case: string; set?: Obj; unset?: string[]; expect?: Obj }[]
  refuse: { case: string; set?: Obj; replace?: unknown }[]
}
// The one table of what a juntos.json may be; Go and the page read it too.
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

describe('hostAllowed', () => {
  it('casa o curinga só com subdomínios do domínio', () => {
    expect(hostAllowed('sa-east-1.cdn.exemplo.dev', ['*.cdn.exemplo.dev'])).toBe(true)
    expect(hostAllowed('cdn.exemplo.dev.evil.com', ['*.cdn.exemplo.dev'])).toBe(false)
    expect(hostAllowed('evilcdn.exemplo.dev', ['*.cdn.exemplo.dev'])).toBe(false)
    expect(hostAllowed('cdn.a.com', ['cdn.a.com'])).toBe(true)
    expect(hostAllowed('x.cdn.a.com', ['cdn.a.com'])).toBe(false)
  })
})
