// The host opens Extensões → an extension, picks something to watch and the
// room gets ready with the video moving; then a host reload in the middle of
// a preparo resumes by asking the extension for a fresh source (`refresh`).
//
// Needs redis, MinIO, Postgres and the Go server at BASE (default :8095) with
// EXTENSION_BASE=localhost:8787 EXTENSION_SCHEME=http and
// GITHUB_API_BASE=GITHUB_RAW_BASE=http://127.0.0.1:8797 (see the e2e-local
// memory). The script plays GitHub on :8797, serving EXT_DIR as the repo
// e2e/<id> at one sha, registers the id straight in DATABASE_URL, starts the
// extension host (wrangler dev on :8787) and stops what it started at the end.
//
// EXT_DIR: the extension's repository, as it would be pushed: juntos.json at
//   the root (it says id and hosts) and the committed build it points at.
// DATABASE_URL: the Go server's Postgres.
// EXT_DRIVER: a module, kept out of this repo, that knows the extension:
//   refs: [string, string]            two things to play, as `ref`s
//   storage(mode): {key: value}       localStorage of the extension's origin (a signed-in session)
//   mock(context, {mediaUrl})         fakes the extension's service; a source for `ref` is mediaUrl(ref)
//   sourceRef(url): string | null     which ref a request to the service asks a source for
//   pick(frame, ref)                  the clicks inside the extension that end in `play`
//   ready: string                     a selector the extension shows once it is up
// EXT_MODE=mock (default): the service is the driver's mock and the media CDN
// is a local server with an MPEG-TS HLS of 20 s behind long signed urls; it
// runs once with CORS and once without, which forces the Worker's media proxy.
// EXT_MODE=real: the real service and CDN.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const { chromium } = createRequire(process.env.PW ?? '/private/tmp/ss-debug/package.json')('playwright')
const base = process.env.BASE ?? 'http://127.0.0.1:8095'
const mode = process.env.EXT_MODE ?? 'mock'
const repo = path.resolve(import.meta.dirname, '../..')
if (!process.env.EXT_DIR || !process.env.EXT_DRIVER) throw new Error('EXT_DIR and EXT_DRIVER are required')
const manifest = JSON.parse(fs.readFileSync(path.join(process.env.EXT_DIR, 'juntos.json'), 'utf8'))
const driver = await import(path.resolve(process.env.EXT_DRIVER))
const EXT_PORT = 8787
const CDN_PORT = Number(process.env.CDN_PORT ?? 8796)
const GH_PORT = Number(process.env.GH_PORT ?? 8797)
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

/** The extension's subdomain: base32 of sha256("juntos-ext:" + id), 16 chars. */
function subFor(id) {
  const bytes = createHash('sha256').update(`juntos-ext:${id}`).digest()
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = ''
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; out.length < 16; i += 5) out += alphabet[Number.parseInt(bits.slice(i, i + 5), 2)]
  return out
}
const sub = subFor(manifest.id)
const extOrigin = `http://${sub}.localhost:${EXT_PORT}`
// A host the manifest lets media come from; `*.domain` takes a made-up subdomain.
const mediaEntry = manifest.hosts.media[0]
const cdnHost = mediaEntry.startsWith('*.') ? `e2e-cdn.${mediaEntry.slice(2)}` : mediaEntry

const check = (name, ok) => { console.log(ok ? 'OK  ' : 'FAIL', name); if (!ok) process.exitCode = 1 }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (name, probe, ms = 120_000, every = 500) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const value = await probe()
    if (value) return value
    await sleep(every)
  }
  throw new Error(`timeout: ${name}`)
}

// ---------------------------------------------------------------- fake CDN

function fakeHls() {
  const dir = path.join(os.tmpdir(), 'juntos-e2e-hls')
  if (fs.existsSync(path.join(dir, 'index.m3u8'))) return dir
  fs.mkdirSync(dir, { recursive: true })
  const ffmpeg = process.env.FFMPEG ?? (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg')
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '20', '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '96k',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(dir, 'seg%d.ts'),
    path.join(dir, 'index.m3u8'),
  ])
  return dir
}

// Shaped like a CDN's signed url: a policy, a short-lived JWT and a key pair id (~450 chars).
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
function mediaUrl(ref) {
  const now = Math.floor(Date.now() / 1000)
  const policy = b64({ iss: 'https://cdn.example/v3', iat: now, exp: now + 7200, jti: 'e2e'.repeat(24) })
  const signature = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ key: ref, iat: now, exp: now + 30 })}.${'s'.repeat(43)}`
  return `https://${cdnHost}/media/${encodeURIComponent(ref)}/index.m3u8?policy=${policy}&signature=${signature}&key-pair-id=APKAE2EEXAMPLE`
}

const cdn = { cors: true, delayMs: 0, hits: [], blocked: 0 }

function startCdn(dir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://cdn')
    const via = req.headers['x-e2e-via'] === 'browser' ? 'browser' : 'proxy'
    const match = /^\/media\/([^/]+)\/(index\.m3u8|seg\d+\.ts)$/.exec(url.pathname)
    cdn.hits.push({ via, method: req.method, ref: match ? decodeURIComponent(match[1]) : null, file: match?.[2] ?? url.pathname })
    const headers = {}
    if (cdn.cors) Object.assign(headers, { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-length, content-range, accept-ranges' })
    // Like a signed CDN: nothing goes out without the signed query string.
    if (!match || !url.searchParams.get('signature') || !url.searchParams.get('policy')) {
      res.writeHead(403, headers).end('forbidden')
      return
    }
    if (match[2] === 'index.m3u8') {
      const text = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8').replace(/^(seg\d+\.ts)$/gm, `$1${url.search}`)
      res.writeHead(200, { ...headers, 'content-type': 'application/vnd.apple.mpegurl' }).end(req.method === 'HEAD' ? undefined : text)
      return
    }
    if (cdn.delayMs) await sleep(cdn.delayMs)
    const body = fs.readFileSync(path.join(dir, match[2]))
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    if (range) {
      const start = Number(range[1])
      const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
      res.writeHead(206, { ...headers, 'content-type': 'video/mp2t', 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${body.length}` })
      res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1))
      return
    }
    res.writeHead(200, { ...headers, 'content-type': 'video/mp2t', 'accept-ranges': 'bytes', 'content-length': body.length })
    res.end(req.method === 'HEAD' ? undefined : body)
  })
  return new Promise((resolve) => server.listen(CDN_PORT, '127.0.0.1', () => resolve(server)))
}

// The browser's own requests to the CDN, with or without CORS as the round wants.
async function routeCdn(ctx) {
  await ctx.route(`https://${cdnHost}/**`, async (route) => {
    // Playwright adds CORS headers to what it fulfills, so a CDN without CORS
    // is played as what the page then sees: a fetch that fails.
    if (!cdn.cors) {
      cdn.blocked++
      return route.abort('failed')
    }
    const request = route.request()
    const url = new URL(request.url())
    const headers = { 'x-e2e-via': 'browser' }
    if (request.headers().range) headers.range = request.headers().range
    const answer = await fetch(`http://127.0.0.1:${CDN_PORT}${url.pathname}${url.search}`, { method: request.method(), headers })
    await route.fulfill({ status: answer.status, headers: Object.fromEntries(answer.headers), body: Buffer.from(await answer.arrayBuffer()) })
  })
}

// ------------------------------------------------------------ fake GitHub

const repoName = `e2e/${manifest.id}`
const SHA = createHash('sha1').update(`e2e:${manifest.id}`).digest('hex')

// The three things juntos and the extension host read from GitHub: the head
// of the default branch, whether the repo is open source, and raw files at a sha.
function startGitHub() {
  const root = path.resolve(process.env.EXT_DIR)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://github')
    if (url.pathname === `/repos/${repoName}/commits/HEAD`) return res.writeHead(200, { 'content-type': 'text/plain' }).end(SHA)
    if (url.pathname === `/repos/${repoName}`) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ private: false, license: { spdx_id: 'MIT' } }))
    const prefix = `/${repoName}/${SHA}/`
    const file = url.pathname.startsWith(prefix) ? path.resolve(root, decodeURIComponent(url.pathname.slice(prefix.length))) : null
    // raw.githubusercontent.com answers any origin, and the panel reads the manifest from the page.
    const cors = { 'access-control-allow-origin': '*' }
    if (!file || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404, cors).end('404: Not Found')
    res.writeHead(200, { ...cors, 'content-type': 'text/plain; charset=utf-8' }).end(fs.readFileSync(file))
  })
  return new Promise((resolve) => server.listen(GH_PORT, '127.0.0.1', () => resolve(server)))
}

// What POST /api/extensions does for a publisher, without signing one in.
function registerExtension() {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
  const sql = `INSERT INTO extensions (id, source, sub, name, icon) VALUES (${[manifest.id, `github:${repoName}`, sub, manifest.name, manifest.icon ?? null].map((v) => (v === null ? 'NULL' : quote(v))).join(', ')})
    ON CONFLICT (id) DO UPDATE SET source = excluded.source, sub = excluded.sub, name = excluded.name, icon = excluded.icon`
  execFileSync('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-qc', sql])
}

// ------------------------------------------------------------ extension host

function hostAnswers() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: EXT_PORT, path: '/', headers: { host: `${sub}.localhost:${EXT_PORT}` } }, (res) => {
      res.resume()
      resolve(res.statusCode === 302)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}

async function startExtensionHost() {
  const args = ['wrangler', 'dev', '--port', String(EXT_PORT), '--ip', '127.0.0.1',
    '--var', `JUNTOS_ORIGIN:${base}`, '--var', `JUNTOS_ORIGINS:${base}`,
    '--var', `EXT_BASE:localhost:${EXT_PORT}`, '--var', 'EXT_SCHEME:http', '--var', `GITHUB_RAW:http://127.0.0.1:${GH_PORT}`]
  if (mode === 'mock') {
    args.splice(2, 0, path.join(repo, 'web/dev/e2e-extensions-host.ts'),
      '--var', `FAKE_CDN:127.0.0.1:${CDN_PORT}`, '--var', `FAKE_CDN_HOSTS:${manifest.hosts.media.join(',')}`)
  }
  // With a script of its own wrangler skips the [build] step that makes the SDK.
  execFileSync('npm', ['run', '--silent', 'build:sdk'], { cwd: path.join(repo, 'extensions/host') })
  const child = spawn('npx', args, { cwd: path.join(repo, 'extensions/host'), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
  const stop = () => { try { process.kill(-child.pid) } catch {} }
  try {
    await until('extension host', hostAnswers, 90_000)
  } catch (error) {
    console.log(log.slice(-2000))
    stop()
    throw error
  }
  return stop
}

// ------------------------------------------------------------------- run

const github = await startGitHub()
registerExtension()
const hls = mode === 'mock' ? fakeHls() : null
const cdnServer = hls ? await startCdn(hls) : null
let stopHost = () => {}
let browser = null
let lastPage = null

const info = async (roomID) => (await fetch(`${base}/api/rooms/${roomID}`)).json()
const sourceCalls = new Map()

async function newContext() {
  const ctx = await browser.newContext({ locale: 'pt-BR' })
  await ctx.addInitScript(({ extOrigin, seed }) => {
    try {
      if (location.origin === extOrigin) {
        for (const [key, value] of Object.entries(seed)) if (localStorage.getItem(key) === null) localStorage.setItem(key, value)
      } else {
        // A room opened in Chrome first hands itself to the desktop app through
        // juntos://; headless Chrome holds that pending and the page stops taking clicks.
        const get = Storage.prototype.getItem
        Storage.prototype.getItem = function (key) { return String(key).startsWith('juntos.open-in-app.') ? '1' : get.call(this, key) }
        localStorage.setItem('ss.onboarding.v1', '1')
        localStorage.setItem('ss.onboarding.v2', '1')
        localStorage.setItem('ss.codec-notice.v1', '1')
      }
    } catch {}
  }, { extOrigin, seed: driver.storage(mode) })
  ctx.on('request', (request) => {
    const ref = driver.sourceRef(request.url(), request.method())
    if (ref !== null) sourceCalls.set(ref, (sourceCalls.get(ref) ?? 0) + 1)
  })
  if (mode === 'mock') {
    await driver.mock(ctx, { mediaUrl })
    await routeCdn(ctx)
  }
  return ctx
}

function wire(page) {
  page.on('console', (message) => {
    if (message.type() === 'error' || /resum|extension|refresh/i.test(message.text())) console.log('[console]', message.text().slice(0, 300))
  })
  page.on('pageerror', (error) => console.log('[pageerror]', error.message))
  page.on('requestfailed', (request) => console.log('[requestfailed]', request.url().slice(0, 120), request.failure()?.errorText))
}

const frame = (page) => page.frameLocator(`iframe[src^="${extOrigin}/"]:not([hidden])`).first()

async function openExtension(page) {
  await page.getByRole('button', { name: 'Compartilhar' }).click()
  await page.getByRole('menuitem', { name: 'Extensões' }).click()
  const row = page.getByRole('button', { name: manifest.name, exact: true })
  // The panel reopens on the extension left open.
  const iframe = page.locator(`iframe[src^="${extOrigin}/"]:not([hidden])`)
  const empty = page.getByText('Nenhuma extensão.')
  await until('panel', async () => (await row.isVisible()) || (await iframe.isVisible()) || (await empty.isVisible()), 30_000)
  // Nothing comes installed: the first time, it goes in by its id.
  if (await empty.isVisible()) {
    await page.getByRole('button', { name: 'Adicionar' }).click()
    await page.getByLabel('ID da extensão').fill(manifest.id)
    await page.getByRole('button', { name: 'Buscar' }).click()
    await page.getByRole('button', { name: 'Instalar' }).click()
    await until('installed', async () => (await row.isVisible()) || (await iframe.isVisible()), 30_000)
  }
  if (await row.isVisible()) await row.click()
  await frame(page).locator(driver.ready).first().waitFor({ timeout: 30_000 })
}

// The room's door shows up again whenever the page loads without a seat.
async function enterDoor(page) {
  const share = page.getByRole('button', { name: 'Compartilhar' })
  const door = page.getByRole('button', { name: /^Entrar$/ })
  await until('room or door', async () => (await share.isVisible().catch(() => false)) || (await door.isVisible().catch(() => false)), 60_000)
  if (await door.isVisible().catch(() => false)) await door.click()
  await share.waitFor({ timeout: 60_000 })
}

async function videoMoves(page, seconds = 5) {
  const video = page.locator('video').first()
  await video.waitFor({ timeout: 60_000 })
  await page.getByRole('button', { name: /play|reproduzir|tocar/i }).first().click().catch(() => {})
  const start = await until('video starts', async () => {
    const t = await video.evaluate((v) => v.currentTime).catch(() => 0)
    return t > 0 ? t : null
  }, 30_000).catch(() => null)
  if (start === null) return false
  const reached = await until(`video moves ${seconds}s`, async () => {
    const t = await video.evaluate((v) => v.currentTime).catch(() => 0)
    return t >= start + seconds ? t : null
  }, 30_000).catch(() => null)
  return reached !== null
}

async function round(label, { cors }) {
  console.log(`\n== ${label}`)
  cdn.cors = cors
  cdn.delayMs = 0
  cdn.hits = []
  cdn.blocked = 0
  sourceCalls.clear()
  const ctx = await newContext()
  const page = await ctx.newPage()
  lastPage = page
  wire(page)
  await page.goto(base)
  await page.getByRole('button', { name: /Criar sala/ }).first().click()
  await page.getByRole('button', { name: /Continuar sem conta/ }).click()
  await page.getByRole('button', { name: /^Entrar$/ }).click()
  await page.waitForURL(/\/room\//, { timeout: 60_000 })
  await enterDoor(page)
  const roomID = page.url().split('/room/')[1].split(/[?#]/)[0]
  const [first, second] = driver.refs

  // 1. Extensões → the extension → pick: the room gets ready and the video plays.
  await openExtension(page)
  await driver.pick(frame(page), first)
  let room = await until('room ready', async () => {
    const r = await info(roomID)
    return r.status === 'ready' && r.mediaGeneration > 0 ? r : null
  }, 180_000, 1000)
  const firstGeneration = room.mediaGeneration
  check(`${label}: room ready after the pick`, room.status === 'ready')
  check(`${label}: the extension asked its service for the source once`, sourceCalls.get(first) === 1)
  check(`${label}: video moves 5 s`, await videoMoves(page))
  if (cdnServer) {
    const via = new Set(cdn.hits.filter((hit) => hit.ref === first).map((hit) => hit.via))
    check(`${label}: CDN read ${cors ? 'by the browser' : 'through the media proxy'} (${[...via]}, ${cdn.blocked} refused)`,
      cors ? via.has('browser') && !via.has('proxy') : via.has('proxy') && !via.has('browser') && cdn.blocked > 0)
  }

  // 2. Another pick, slowed down; the host reloads in the middle of its preparo.
  if (cdnServer) cdn.delayMs = 1500
  await openExtension(page)
  await driver.pick(frame(page), second)
  await until('second preparo under way', async () => {
    const r = await info(roomID)
    const segments = cdnServer ? cdn.hits.filter((hit) => hit.ref === second && hit.file.endsWith('.ts') && hit.method === 'GET').length : 1
    return r.mediaGeneration > firstGeneration && r.status !== 'ready' && segments > 0
  }, 60_000)
  await page.reload()
  await enterDoor(page)
  if (cdnServer) cdn.delayMs = 0
  await until('refresh asked the extension again', async () => (sourceCalls.get(second) ?? 0) >= 2, 60_000).catch(() => {})
  check(`${label}: the reload asked the extension for a fresh source`, sourceCalls.get(second) === 2)
  room = await until('room ready after resume', async () => {
    const r = await info(roomID)
    return r.status === 'ready' && r.mediaGeneration > firstGeneration ? r : null
  }, 180_000, 1000)
  check(`${label}: room ready after the resumed preparo`, room.status === 'ready')
  check(`${label}: no hidden extension iframe left behind`, await page.locator(`iframe[src^="${extOrigin}/"]`).count() === 0)
  check(`${label}: video moves 5 s after the resume`, await videoMoves(page))
  await ctx.close()
}

try {
  stopHost = await startExtensionHost()
  browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] })
  if (mode === 'mock') {
    await round('mock, CDN with CORS', { cors: true })
    await round('mock, CDN without CORS', { cors: false })
  } else {
    await round('real service', { cors: true })
  }
} catch (error) {
  console.log('FAIL', error.message)
  process.exitCode = 1
  const shot = process.env.SHOT ?? path.join(os.tmpdir(), 'e2e-extensions-fail.png')
  await lastPage?.screenshot({ path: shot }).then(() => console.log('screenshot', shot), () => {})
} finally {
  await browser?.close()
  stopHost()
  cdnServer?.close()
  github.close()
}
