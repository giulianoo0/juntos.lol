// What every extension e2e needs: GitHub played locally with the extension's
// repository at one sha, the id registered in Postgres, the extension host
// (wrangler dev), a room created by an anonymous host and the Extensões panel.
// e2e-extensions.mjs uses it, and so can an extension's own e2e from its repo.
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

export const repo = path.resolve(import.meta.dirname, '../..')

export const check = (name, ok) => { console.log(ok ? 'OK  ' : 'FAIL', name); if (!ok) process.exitCode = 1 }
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const until = async (name, probe, ms = 120_000, every = 500) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const value = await probe()
    if (value) return value
    await sleep(every)
  }
  throw new Error(`timeout: ${name}`)
}

/** The extension's subdomain: base32 of sha256("juntos-ext:" + id), 16 chars. */
export function subFor(id) {
  const bytes = createHash('sha256').update(`juntos-ext:${id}`).digest()
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = ''
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; out.length < 16; i += 5) out += alphabet[Number.parseInt(bits.slice(i, i + 5), 2)]
  return out
}

/**
 * The extension at `dir` as juntos would find it published, with what it
 * takes to serve it: `start()` brings up GitHub and the host, `stop()` ends both.
 */
export function extension(dir, { base, extPort = 8787, ghPort = 8797, mediaKey = 'e2e-media-key', hostScript = null, hostVars = [] } = {}) {
  const root = path.resolve(dir)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'juntos.json'), 'utf8'))
  const sub = subFor(manifest.id)
  const origin = `http://${sub}.localhost:${extPort}`
  const repoName = `e2e/${manifest.id}`
  const sha = createHash('sha1').update(`e2e:${manifest.id}`).digest('hex')
  let github = null
  let host = null

  // The three things juntos and the extension host read from GitHub: the head
  // of the default branch, whether the repo is open source, and raw files at a sha.
  function startGitHub() {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://github')
      if (url.pathname === `/repos/${repoName}/commits/HEAD`) return res.writeHead(200, { 'content-type': 'text/plain' }).end(sha)
      if (url.pathname === `/repos/${repoName}`) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ private: false, license: { spdx_id: 'MIT' } }))
      const prefix = `/${repoName}/${sha}/`
      const file = url.pathname.startsWith(prefix) ? path.resolve(root, decodeURIComponent(url.pathname.slice(prefix.length))) : null
      // raw.githubusercontent.com answers any origin, and the panel reads the manifest from the page.
      const cors = { 'access-control-allow-origin': '*' }
      if (!file || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404, cors).end('404: Not Found')
      res.writeHead(200, { ...cors, 'content-type': 'text/plain; charset=utf-8' }).end(fs.readFileSync(file))
    })
    return new Promise((resolve) => server.listen(ghPort, '127.0.0.1', () => resolve(server)))
  }

  // What POST /api/extensions does for a publisher, without signing one in.
  function register() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
    const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
    const values = [manifest.id, `github:${repoName}`, sub, manifest.name, manifest.icon ?? null].map((v) => (v === null ? 'NULL' : quote(v)))
    const sql = `INSERT INTO extensions (id, source, sub, name, icon) VALUES (${values.join(', ')})
      ON CONFLICT (id) DO UPDATE SET source = excluded.source, sub = excluded.sub, name = excluded.name, icon = excluded.icon`
    execFileSync('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-qc', sql])
  }

  function hostAnswers() {
    return new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: extPort, path: '/', headers: { host: `${sub}.localhost:${extPort}` } }, (res) => {
        res.resume()
        resolve(res.statusCode === 302)
      })
      req.on('error', () => resolve(false))
      req.end()
    })
  }

  async function startHost() {
    const args = ['wrangler', 'dev', '--port', String(extPort), '--ip', '127.0.0.1',
      '--var', `JUNTOS_ORIGIN:${base}`, '--var', `JUNTOS_ORIGINS:${base}`,
      '--var', `EXT_BASE:localhost:${extPort}`, '--var', 'EXT_SCHEME:http', '--var', `GITHUB_RAW:http://127.0.0.1:${ghPort}`,
      // The server at `base` signs media tickets with the same EXTENSION_MEDIA_KEY.
      '--var', `MEDIA_KEY:${mediaKey}`, ...hostVars]
    if (hostScript) args.splice(2, 0, hostScript)
    // With a script of its own wrangler skips the [build] step that makes the SDK.
    execFileSync('npm', ['run', '--silent', 'build:sdk'], { cwd: path.join(repo, 'extensions/host') })
    const child = spawn('npx', args, { cwd: path.join(repo, 'extensions/host'), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let log = ''
    child.stdout.on('data', (chunk) => { log += chunk })
    child.stderr.on('data', (chunk) => { log += chunk })
    const kill = () => { try { process.kill(-child.pid) } catch {} }
    try {
      await until('extension host', hostAnswers, 90_000)
    } catch (error) {
      console.log(log.slice(-2000))
      kill()
      throw error
    }
    return kill
  }

  return {
    manifest, sub, origin,
    async start() {
      github = await startGitHub()
      register()
      host = await startHost()
    },
    stop() {
      host?.()
      github?.close()
    },
  }
}

/**
 * Seeds the extension's localStorage with `seed` and keeps juntos' own
 * first-run covers out of the way of the clicks.
 */
export async function prepareContext(ctx, { origin, seed = {} }) {
  await ctx.addInitScript(({ origin, seed }) => {
    try {
      if (location.origin === origin) {
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
  }, { origin, seed })
}

export function wire(page, pattern = /resum|extension|refresh/i) {
  page.on('console', (message) => {
    if (message.type() === 'error' || pattern.test(message.text())) console.log('[console]', message.text().slice(0, 300))
  })
  page.on('pageerror', (error) => console.log('[pageerror]', error.message))
  page.on('requestfailed', (request) => console.log('[requestfailed]', request.url().slice(0, 120), request.failure()?.errorText))
}

export const roomInfo = async (base, roomID) => (await fetch(`${base}/api/rooms/${roomID}`)).json()

/** An anonymous host creates a room and takes a seat; the room's id. */
export async function createRoom(page, base) {
  await page.goto(base)
  await page.getByRole('button', { name: /Criar sala/ }).first().click()
  await page.getByRole('button', { name: /Continuar sem conta/ }).click()
  await page.getByRole('button', { name: /^Entrar$/ }).click()
  await page.waitForURL(/\/room\//, { timeout: 60_000 })
  await enterDoor(page)
  return page.url().split('/room/')[1].split(/[?#]/)[0]
}

// The room's door shows up again whenever the page loads without a seat.
export async function enterDoor(page) {
  const share = page.getByRole('button', { name: 'Compartilhar' })
  const door = page.getByRole('button', { name: /^Entrar$/ })
  await until('room or door', async () => (await share.isVisible().catch(() => false)) || (await door.isVisible().catch(() => false)), 60_000)
  if (await door.isVisible().catch(() => false)) await door.click()
  await share.waitFor({ timeout: 60_000 })
}

export const extensionFrame = (page, origin) => page.frameLocator(`iframe[src^="${origin}/"]:not([hidden])`).first()

/** Compartilhar → Extensões → the extension, installing it by id the first time. */
export async function openExtension(page, { manifest, origin }, ready) {
  await page.getByRole('button', { name: 'Compartilhar' }).click()
  await page.getByRole('menuitem', { name: 'Extensões' }).click()
  const row = page.getByRole('button', { name: manifest.name, exact: true })
  // The panel reopens on the extension left open.
  const iframe = page.locator(`iframe[src^="${origin}/"]:not([hidden])`)
  const empty = page.getByText('Nenhuma extensão.')
  await until('panel', async () => (await row.isVisible()) || (await iframe.isVisible()) || (await empty.isVisible()), 30_000)
  if (await empty.isVisible()) {
    await page.getByRole('button', { name: 'Adicionar' }).click()
    await page.getByLabel('ID da extensão').fill(manifest.id)
    await page.getByRole('button', { name: 'Buscar' }).click()
    await page.getByRole('button', { name: 'Instalar' }).click()
    await until('installed', async () => (await row.isVisible()) || (await iframe.isVisible()), 30_000)
  }
  if (await row.isVisible()) await row.click()
  // The frame of a panel just closed lingers while it animates out.
  await until('one extension frame', async () => (await page.locator(`iframe[src^="${origin}/"]`).count()) === 1, 10_000).catch(() => {})
  await extensionFrame(page, origin).locator(ready).first().waitFor({ timeout: 30_000 })
}

export async function videoMoves(page, seconds = 5, { startMs = 30_000 } = {}) {
  const video = page.locator('video').first()
  await video.waitFor({ timeout: 60_000 })
  await page.getByRole('button', { name: /play|reproduzir|tocar/i }).first().click().catch(() => {})
  const start = await until('video starts', async () => {
    const t = await video.evaluate((v) => v.currentTime).catch(() => 0)
    return t > 0 ? t : null
  }, startMs).catch(() => null)
  if (start === null) return false
  const reached = await until(`video moves ${seconds}s`, async () => {
    const t = await video.evaluate((v) => v.currentTime).catch(() => 0)
    return t >= start + seconds ? t : null
  }, 30_000 + seconds * 2000).catch(() => null)
  return reached !== null
}
