import { describe, expect, it } from 'vitest'
import { route } from '../src/route'

const SHA = 'a'.repeat(40)

describe('route', () => {
  it('reconhece as rotas', () => {
    expect(route('/')).toEqual({ kind: 'root' })
    expect(route('/_juntos/sdk.js')).toEqual({ kind: 'sdk' })
    expect(route('/_juntos/media')).toEqual({ kind: 'media' })
    expect(route(`/@${SHA}/index.html`)).toEqual({ kind: 'file', version: SHA, path: 'index.html' })
    expect(route(`/@${SHA}/assets/a-B_1.woff2`)).toEqual({ kind: 'file', version: SHA, path: 'assets/a-B_1.woff2' })
  })

  it.each([
    `/@${SHA}/../x.js`,
    `/@${SHA}/a/../x.js`,
    `/@${SHA}/%2e%2e/x.js`,
    `/@${SHA}/%2E%2e/x.js`,
    `/@${SHA}/a%2f..%2fx.js`,
    `/@${SHA}/a\\x.js`,
    `/@${SHA}/a%5cx.js`,
    `/@${SHA}/x.js%00`,
    `/@${SHA}/x%00.js`,
    `/@${SHA}/./x.js`,
    `/@${SHA}//x.js`,
    `/@${SHA}/.hidden.js`,
    `/@${SHA}/%zz.js`,
    `/@${SHA}/x.exe`,
    `/@${SHA}/x.htm`,
    `/@${SHA}/x`,
    '/@/x.js',
    '/@ju ntos/x.js',
    '/@juntos/x.js',
    '/@main/x.js',
    `/@${'A'.repeat(40)}/x.js`,
    `/@${'a'.repeat(39)}/x.js`,
    '/x.js',
    '/_juntos/outra',
    `/@${SHA}/..%2f..%2fapi`,
    `/@${SHA}/%252e%252e/x.js`,
    `/@${SHA}/x.js%2500`,
    `/@${SHA}/a%2Fb.js`,
    `/@${SHA}/x.js/`,
    `/@${SHA}/x.JS`,
  ])('recusa %s', (p) => {
    expect(route(p)).toBeNull()
  })

  it.each(['html', 'js', 'mjs', 'css', 'json', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'woff2', 'ico'])('aceita .%s', (ext) => {
    expect(route(`/@${SHA}/a.${ext}`)).not.toBeNull()
  })
})
