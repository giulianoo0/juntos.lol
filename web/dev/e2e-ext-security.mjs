// Attacks on the extension isolation, end to end: a hostile extension
// (extensions/host/test/fixtures/evil) served by the real host Worker
// (wrangler dev on :8788) inside a real juntos (Go server on :8096), plus raw
// HTTP against both. Brings the stack up and down by itself; needs Postgres
// (DATABASE_ADMIN_URL), Redis on :6379, the web build in web/dist and PW
// pointing at a playwright install. Optional MinIO on :9000 for the upload.
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium } = createRequire(process.env.PW ?? '/private/tmp/ss-debug/package.json')('playwright')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SERVER_PORT = 8096
const HOST_PORT = 8788
const base = `http://127.0.0.1:${SERVER_PORT}`
const adminDb = process.env.DATABASE_ADMIN_URL ?? 'postgres://giuli@localhost:5432/postgres?sslmode=disable'
const dbName = 'juntos_e2e_ext_security'
const dbUrl = adminDb.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`)

const check = (name, ok, detail = '') => {
  console.log(ok ? 'OK  ' : 'FAIL', name, ok || !detail ? '' : `→ ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  if (!ok) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Same formula as the Worker and the Go registry. */
function subFor(id) {
  const digest = createHash('sha256').update(`juntos-ext:${id}`).digest()
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0, value = 0, out = ''
  for (const byte of digest) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  return out.slice(0, 16)
}
const EVIL = subFor('maligna')
const NEIGHBOUR = subFor('vizinha')
const evilOrigin = `http://${EVIL}.localhost:${HOST_PORT}`
const neighbourOrigin = `http://${NEIGHBOUR}.localhost:${HOST_PORT}`

// ── stack ───────────────────────────────────────────────────────────────────
const work = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ext-security-'))
const children = []
function start(name, cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = []
  child.stdout.on('data', (d) => log.push(String(d)))
  child.stderr.on('data', (d) => log.push(String(d)))
  children.push({ name, child, log })
  return { child, log }
}
function down() {
  for (const { child } of children) { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
  try { execFileSync('psql', [adminDb, '-qc', `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`], { stdio: 'ignore' }) } catch {}
  rmSync(work, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { down(); process.exit(130) })
async function until(name, probe, ms = 60_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await probe().catch(() => false)) return; await sleep(300) }
  for (const c of children) console.log(`[${c.name}]`, c.log.join('').slice(-2000))
  throw new Error(`timeout: ${name}`)
}

const webDir = path.join(work, 'web')
cpSync(path.join(repo, 'web/dist'), webDir, { recursive: true })
mkdirSync(path.join(webDir, 'extensions'), { recursive: true })
cpSync(path.join(repo, 'extensions/host/test/fixtures/evil'), path.join(webDir, 'extensions/maligna'), { recursive: true })
cpSync(path.join(repo, 'extensions/host/test/fixtures/neighbour'), path.join(webDir, 'extensions/vizinha'), { recursive: true })

execFileSync('psql', [adminDb, '-qc', `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`])
execFileSync('psql', [adminDb, '-qc', `CREATE DATABASE ${dbName}`])
execFileSync('go', ['build', '-o', path.join(work, 'server'), './cmd/server'], { cwd: repo, stdio: 'inherit' })

let results = null
let browser = null
try {
  start('server', path.join(work, 'server'), [], {
    cwd: repo,
    env: {
      ...process.env, PORT: String(SERVER_PORT), REDIS_URL: 'redis://127.0.0.1:6379', DATABASE_URL: dbUrl,
      DATA_DIR: path.join(work, 'data'), WEB_DIR: webDir, PUBLIC_ORIGIN: base,
      R2_ENDPOINT: '127.0.0.1:9000', R2_INSECURE: '1', R2_ACCOUNT_ID: 'local', R2_BUCKET: 'ss-media',
      R2_ACCESS_KEY_ID: 'e2e', R2_SECRET_ACCESS_KEY: 'e2esecret', MEDIA_PUBLIC_URL: 'http://127.0.0.1:9000/ss-media',
      EXTENSION_BASE: `localhost:${HOST_PORT}`, EXTENSION_SCHEME: 'http',
    },
  })
  await until('server', async () => (await fetch(`${base}/api/config`)).ok)
  const register = (id, name) => execFileSync('psql', [dbUrl, '-qc',
    `INSERT INTO extensions (id, source, sub, name) VALUES ('${id}', 'juntos:${id}', '${subFor(id)}', $$${name}$$)`])
  register('maligna', 'Maligna <img src=x onerror=top.__pwned=1>')
  register('vizinha', 'Vizinha')

  // The SDK is built once here: wrangler's own build step rewrites a watched
  // file and would restart the Worker in a loop.
  const hostDir = path.join(repo, 'extensions/host')
  execFileSync('node', ['scripts/build-sdk.mjs'], { cwd: hostDir })
  writeFileSync(path.join(work, 'wrangler.toml'), `name = "juntos-ext"\nmain = "${path.join(hostDir, 'src/index.ts')}"\ncompatibility_date = "2026-10-01"\n`)
  start('worker', path.join(hostDir, 'node_modules/.bin/wrangler'), ['dev', '-c', path.join(work, 'wrangler.toml'),
    '--persist-to', path.join(work, 'wrangler-state'), '--port', String(HOST_PORT), '--ip', '127.0.0.1',
    '--var', `JUNTOS_ORIGIN:${base}`, '--var', `JUNTOS_ORIGINS:${base}`,
    '--var', `EXT_BASE:localhost:${HOST_PORT}`, '--var', 'EXT_SCHEME:http'], { cwd: path.join(repo, 'extensions/host') })
  await until('worker', async () => (await raw('/@juntos/juntos.json', `${EVIL}.localhost:${HOST_PORT}`)).status === 200, 120_000)

  results = await attack()
} catch (error) {
  for (const c of children) console.log(`[${c.name}]`, c.log.join('').slice(-1500))
  console.log(error)
  // HOLD keeps the stack up after a failure, to look around by hand.
  if (process.env.HOLD) await sleep(Number(process.env.HOLD) * 1000)
} finally {
  await browser?.close().catch(() => {})
  if (!process.env.KEEP) down()
}
if (results === null) process.exitCode = 1

/** A request with the path and Host exactly as given, nothing normalized. */
function raw(pathname, host, { port = HOST_PORT, headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host, ...headers } }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function attack() {
  const evilHost = `${EVIL}.localhost:${HOST_PORT}`
  const neighbourHost = `${NEIGHBOUR}.localhost:${HOST_PORT}`

  // ── host Worker over raw HTTP ─────────────────────────────────────────────
  for (const p of ['/@juntos/..%2f..%2fapi', '/@juntos/../juntos.json', '/@juntos/%2e%2e/%2e%2e/api/config', '/@juntos/%252e%252e/x.js',
    '/@juntos/..%5c..%5cjuntos.json', '/@juntos/evil.js%00.png', '/@juntos//evil.js', '/@juntos/evil.JS', '/@juntos/.env',
    '/@juntos/..\\..\\api/config', '/@juntos/a\\..\\..\\..\\extensions/vizinha/neighbour.js', `/@${'a'.repeat(40)}/evil.js`, '/@juntos/evil.php']) {
    const res = await raw(p, evilHost)
    check(`host: ${p} → 404`, res.status === 404, String(res.status))
  }
  const page = await raw('/@juntos/index.html', evilHost)
  const csp = page.headers['content-security-policy'] ?? ''
  check('host: html com CSP do manifesto', page.status === 200 && csp.includes("frame-ancestors " + base) && csp.includes("script-src 'self';")
    && csp.includes("form-action 'none'") && csp.includes("connect-src 'self' https://api.example.com;") && csp.includes("frame-src 'none'"), csp)
  check('host: nosniff, no-referrer, COOP e sem cookie', page.headers['x-content-type-options'] === 'nosniff'
    && page.headers['referrer-policy'] === 'no-referrer' && page.headers['cross-origin-opener-policy'] === 'same-origin' && !page.headers['set-cookie'])
  const svg = await raw('/@juntos/bad.svg', evilHost)
  check('host: svg sai com a mesma CSP', svg.status === 200 && svg.headers['content-security-policy'] === csp)
  const forged = await raw('/@juntos/evil.js', neighbourHost)
  check('host: o Host de outra extensão não serve os arquivos desta', forged.status === 404, String(forged.status))
  const foreign = await raw('/@juntos/evil.js', `${EVIL}.evil.example`)
  check('host: Host fora da base → 404', foreign.status === 404, String(foreign.status))
  const unknown = await raw('/@juntos/evil.js', `aaaaaaaaaaaaaaaa.localhost:${HOST_PORT}`)
  check('host: sub não registrado → 404', unknown.status === 404, String(unknown.status))

  const media = (u) => `/_juntos/media?u=${encodeURIComponent(u)}`
  check('proxy: sem Origin → 403', (await raw(media('https://cdn.media.example/a.ts'), evilHost)).status === 403)
  check('proxy: Origin estranha → 403', (await raw(media('https://cdn.media.example/a.ts'), evilHost, { headers: { origin: 'https://evil.example' } })).status === 403)
  for (const u of ['https://evil.example/a.ts', 'http://cdn.media.example/a.ts', 'https://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/a.ts', 'https://0x7f000001/a.ts', 'https://[::1]/a.ts', 'https://localhost/a.ts',
    'https://u:p@cdn.media.example/a.ts', 'https://cdn.media.example:8443/a.ts', 'https://cdn.media.example.evil.example/a.ts']) {
    const res = await raw(media(u), evilHost, { headers: { origin: base } })
    check(`proxy: ${u} → 403`, res.status === 403, String(res.status))
  }
  check('proxy: POST → 405', (await raw(media('https://cdn.media.example/a.ts'), evilHost, { method: 'POST', headers: { origin: base } })).status === 405)

  // ── juntos server ─────────────────────────────────────────────────────────
  const onSite = await raw('/extensions/maligna/index.html', `127.0.0.1:${SERVER_PORT}`, { port: SERVER_PORT })
  check('site: /extensions/ sai em sandbox', onSite.headers['content-security-policy'] === "sandbox; default-src 'none'", onSite.headers['content-security-policy'])

  // No popup blocker: what a popup could do matters here, not whether one opens without a click.
  browser = await chromium.launch({ channel: 'chrome', args: ['--disable-popup-blocking'] })
  const context = await browser.newContext({ locale: 'pt-BR' })
  await context.addInitScript(() => { try { localStorage.setItem('ss.onboarding.v1', '1'); localStorage.setItem('ss.onboarding.v2', '1'); localStorage.setItem('ss.codec-notice.v1', '1') } catch {} })

  // Media and attacker pages, in memory.
  const requests = []
  context.on('request', (r) => requests.push(r.url()))
  const seg = Buffer.alloc(4096, 0x47)
  await context.route('https://cdn.media.example/**', (route) => {
    const u = new URL(route.request().url())
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-length, content-range' }
    if (u.pathname.endsWith('/ok.m3u8')) return route.fulfill({ headers: { ...cors, 'content-type': 'application/vnd.apple.mpegurl' }, body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n' })
    if (u.pathname.endsWith('/leak.m3u8')) return route.fulfill({ headers: { ...cors, 'content-type': 'application/vnd.apple.mpegurl' }, body: `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n${base}/__leak.ts\n#EXTINF:6,\nhttp://192.168.0.1/__leak.ts\n#EXT-X-ENDLIST\n` })
    return route.fulfill({ headers: { ...cors, 'content-type': 'video/mp2t', 'content-length': String(seg.length) }, body: route.request().method() === 'HEAD' ? '' : seg })
  })
  const playMsg = `{ juntos: 1, type: 'play', title: 'de fora', ref: '1', source: { kind: 'hls', url: 'https://cdn.media.example/ep/ok.m3u8' } }`
  await context.route('https://attacker.example/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<script>
      // Opened by juntos: its opener is juntos. Opened by the extension: its opener's parent is.
      const t = window.opener ? window.opener.parent : window.parent;
      setTimeout(() => { t.postMessage(${playMsg}, '*'); document.title = 'sent' }, 300);
    </script>`,
  }))
  const mediaHits = () => requests.filter((u) => u.startsWith('https://cdn.media.example/')).length

  // Opened directly on the site, the extension's page must not run.
  const direct = await context.newPage()
  await direct.goto(`${base}/extensions/maligna/index.html`)
  await sleep(500)
  check('site: a página da extensão aberta no juntos não roda script', await direct.evaluate(() => window.__results === undefined))
  // An svg with script, opened on the extension origin.
  await direct.goto(`${evilOrigin}/@juntos/bad.svg`)
  await sleep(300)
  check('host: svg com script e onload não roda', !/pwned/.test(await direct.title()), await direct.title())
  // The neighbour keeps a secret on its own origin.
  await direct.goto(`${neighbourOrigin}/@juntos/index.html`)
  check('vizinha guardou o segredo na própria origem', await direct.evaluate(() => window.__stored) === 'token-da-vizinha')
  await direct.close()

  // ── the room ──────────────────────────────────────────────────────────────
  const room = await context.newPage()
  room.on('pageerror', (e) => console.log('[room pageerror]', e.message))
  room.on('requestfailed', (q) => { if (!q.url().startsWith('https://evil.example')) console.log('[room failed]', q.url().slice(0, 120), q.failure()?.errorText) })
  room.on('response', (res) => { if (res.status() >= 400 && res.url().startsWith(base)) console.log('[room http]', res.status(), res.url().slice(0, 120)) })
  room.on('dialog', (d) => { console.log('[room dialog]', d.message()); void d.dismiss() })
  await room.goto(base)
  await room.getByRole('button', { name: /Criar sala/ }).first().click()
  await room.getByRole('button', { name: /Continuar sem conta/ }).click()
  await room.waitForURL(/\/room\//, { timeout: 60_000 })
  // The room's door shows up again whenever the page loads without a seat.
  const share = room.getByRole('button', { name: 'Compartilhar', exact: true })
  const door = room.getByRole('button', { name: /^Entrar$/ })
  await until('inside the room', async () => {
    if (await share.isVisible()) return true
    // Pointer clicks do not land on the room page under Playwright; the form submits fine.
    if (await door.isVisible()) { await room.evaluate(() => document.querySelector('form')?.requestSubmit()); await sleep(1500) }
    return false
  }, 60_000)
  const roomUrl = room.url()
  const roomID = roomUrl.split('/room/')[1].split(/[?#]/)[0]
  const roomInfo = async () => (await fetch(`${base}/api/rooms/${roomID}`)).json()
  const notPwned = async (name) => {
    const state = await room.evaluate(() => ({ pwned: window.__pwned, injected: document.querySelectorAll('img[src="x"], svg[onload]').length }))
    check(`${name}: juntos intacto`, room.url() === roomUrl && state.pwned === undefined && state.injected === 0, { url: room.url(), ...state })
  }
  // Opens the hostile extension afresh: a new iframe, a new page load.
  const openEvil = async () => {
    const back = room.getByRole('button', { name: 'Voltar' })
    if (!(await room.getByRole('dialog').isVisible().catch(() => false))) {
      // Pointer clicks do not open the room's popovers under Playwright; a synthetic click does.
      await room.getByRole('button', { name: 'Compartilhar', exact: true }).dispatchEvent('click')
      await room.getByRole('menuitem', { name: 'Extensões' }).dispatchEvent('click')
    }
    // The panel reopens on the extension left open: back to the list first.
    if (await back.waitFor({ timeout: 3_000 }).then(() => true, () => false)) await back.dispatchEvent('click')
    const row = room.getByRole('button', { name: 'Maligna <img src=x onerror=top.__pwned=1>' })
    await row.waitFor({ timeout: 10_000 })
    await row.dispatchEvent('click')
    let frame = null
    await until('evil frame', async () => {
      frame = room.frames().find((f) => f.url().startsWith(evilOrigin))
      return frame && (await frame.evaluate(() => window.__results?.done === true))
    }, 30_000)
    return frame
  }

  let frame = await openEvil()
  check('painel: nome com HTML aparece como texto', await room.getByRole('heading', { name: 'Maligna <img src=x onerror=top.__pwned=1>' }).isVisible())
  const r = await frame.evaluate(() => window.__results)
  console.log('     resultados dentro da extensão:', JSON.stringify(r))
  check('extensão: window.parent.document lança', r.parentDocument === 'threw SecurityError', r.parentDocument)
  check('extensão: localStorage do juntos lança', r.parentLocalStorage === 'threw SecurityError', r.parentLocalStorage)
  check('extensão: não lê a url do juntos', r.parentLocation === 'threw SecurityError', r.parentLocation)
  check('extensão: eval barrado pela CSP', r.eval.startsWith('threw'), r.eval)
  check('extensão: script inline não roda', r.inlineRan !== true)
  check('extensão: fetch para host não declarado é recusado', r.fetchUndeclared.startsWith('refused'), r.fetchUndeclared)
  check('extensão: fetch para o juntos é recusado', r.fetchJuntos.startsWith('refused'), r.fetchJuntos)
  check('extensão: nenhum cookie do juntos à vista', !/ss_|human|session/i.test(r.cookie), r.cookie)
  check('extensão: não vê o localStorage da vizinha', r.ownStorage === 'read: null', r.ownStorage)
  const v = r.violations.join(' | ')
  for (const [what, needle] of [['img para host não declarado', 'img-src https://evil.example'], ['fetch para host não declarado', 'connect-src https://evil.example'],
    ['beacon', 'connect-src https://evil.example/beacon'], ['websocket', 'connect-src wss://evil.example'], ['iframe de outra origem', 'frame-src'],
    ['script inline', 'script-src-elem inline'], ['eval', 'script-src eval']]) {
    check(`CSP barrou ${what}`, v.includes(needle), v)
  }
  await sleep(500)
  await notPwned('top.location, location.replace e open(_top)')

  // Hostile messages, one after another: none may start anything.
  const sent = await frame.evaluate(() => window.__attack.hostileMessages())
  await sleep(1500)
  check(`${sent} mensagens hostis ignoradas (nenhuma busca de mídia, painel aberto)`, mediaHits() === 0 && await room.getByRole('dialog').isVisible(), String(mediaHits()))
  await notPwned('mensagens hostis')

  // A link with target=_top, clicked for real.
  await frame.locator('#top-link').click()
  await sleep(800)
  await notPwned('link target=_top clicado')

  // A popup the extension opens on its own origin: sandboxed and COOP, the
  // page does not even load there; if it did, it would have no opener.
  const [popup] = await Promise.all([context.waitForEvent('page'), frame.evaluate(() => window.__attack.popup())])
  await popup.waitForLoadState().catch(() => {})
  await sleep(1000)
  const pr = await popup.evaluate(() => window.__results ?? null).catch(() => null)
  check('popup da extensão: não carrega ou nasce sem opener', pr === null || pr.hasOpener === false, pr)
  await popup.close()
  // A popup the extension opens elsewhere: it has an opener, and posts a valid
  // play to juntos through it.
  const [elsewhere] = await Promise.all([context.waitForEvent('page'), frame.evaluate(() => { window.open('https://attacker.example/popup') })])
  const elsewhereSent = await elsewhere.waitForFunction(() => document.title === 'sent', null, { timeout: 5_000 }).then(() => true, () => false)
  await sleep(800)
  check('popup de outra origem: play pelo opener ignorado', elsewhereSent && mediaHits() === 0, { elsewhereSent, hits: mediaHits() })
  await notPwned('popup')
  await elsewhere.close()

  // A window juntos opened, sending a valid play.
  const [stranger] = await Promise.all([context.waitForEvent('page'), room.evaluate(() => { window.open('https://attacker.example/aba') })])
  const strangerSent = await stranger.waitForFunction(() => document.title === 'sent', null, { timeout: 5_000 }).then(() => true, () => false)
  await sleep(800)
  check('outra aba: play válido de outra origem ignorado', strangerSent && mediaHits() === 0, { strangerSent, hits: mediaHits() })
  await stranger.close()

  // The extension's iframe navigated to another origin: same window, wrong origin.
  await frame.evaluate(() => { location.href = 'https://attacker.example/frame' })
  await until('frame navigated', async () => room.frames().some((f) => f.url().startsWith('https://attacker.example/frame')), 10_000)
  const navigated = room.frames().find((f) => f.url().startsWith('https://attacker.example/frame'))
  const frameSent = await navigated.waitForFunction(() => document.title === 'sent', null, { timeout: 5_000 }).then(() => true, () => false)
  await sleep(800)
  check('iframe de outra origem no lugar da extensão: play ignorado', frameSent && mediaHits() === 0, { frameSent, hits: mediaHits() })
  await notPwned('iframe navegado')

  // Reopen; a play on the declared host whose playlist leads to juntos and the LAN.
  frame = await openEvil()
  await frame.evaluate(() => window.__attack.leakyPlaylist())
  await sleep(2500)
  const leaks = requests.filter((u) => u.includes('__leak'))
  check('playlist que leva ao juntos e à rede local: nada é buscado lá', requests.some((u) => u.endsWith('/leak.m3u8')) && leaks.length === 0, leaks)

  // The play that passes: HTML in the title and subtitle stays text in the room.
  const title = '<img src=x onerror=top.__pwned=1>'
  frame = await openEvil()
  await frame.evaluate((t) => window.__attack.htmlTitle(t), title)
  const expected = `${title} · "><svg onload=top.__pwned=1>`
  await until('room title', async () => (await roomInfo()).fileName === expected, 20_000)
  await sleep(1000)
  check('título com HTML chega à sala como texto', (await room.locator('body').innerText()).includes(expected))
  await notPwned('título com HTML na sala')

  // Form posts and meta refresh.
  frame = await openEvil()
  await frame.evaluate(() => window.__attack.form())
  await sleep(800)
  const after = await frame.evaluate(() => window.__results.violations.join(' | '))
  check('form action barrado (form-action none)', after.includes('form-action'), after)
  await frame.evaluate(() => window.__attack.metaRefresh())
  await sleep(1500)
  await notPwned('meta refresh para o juntos')
  const framedJuntos = await Promise.all(room.frames().filter((f) => f.url().startsWith(base) && f !== room.mainFrame())
    .map((f) => f.evaluate(() => document.body?.innerText ?? '').catch(() => '')))
  check('juntos não carrega dentro do iframe (X-Frame-Options)', framedJuntos.every((t) => t === ''), framedJuntos)

  return true
}
