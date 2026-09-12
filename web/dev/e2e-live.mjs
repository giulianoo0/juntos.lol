import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const { chromium } = createRequire(process.env.PW ?? '/private/tmp/ss-debug/package.json')('playwright')
const base = process.env.BASE ?? 'http://127.0.0.1:8090'
const t0 = Date.now()
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6)
// A live that is on the air right now, found the way the producer will read it.
let link = process.env.LINK
if (!link) {
  const out = execFileSync('/opt/homebrew/bin/yt-dlp', ['--flat-playlist', '-J', 'ytsearch15:24/7 live stream'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const entries = JSON.parse(out).entries.filter((e) => e.live_status === 'is_live')
  link = `https://www.youtube.com/watch?v=${entries[0].id}`
}
console.log(ts(), 'live', link)
const browser = await chromium.launch({ channel: 'chrome', args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'] })
const context = async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR' })
  await ctx.addInitScript(() => { try { localStorage.setItem('ss.onboarding.v1', '1'); localStorage.setItem('ss.codec-notice.v1', '1') } catch {} })
  return ctx
}
const wire = (page, tag) => {
  page.on('console', (m) => { const x = m.text(); if (/ERR_CONNECTION_REFUSED/.test(x)) return; if (m.type() === 'error' || /live|catalog|moq|relay|failed|refused/i.test(x)) console.log(ts(), `[${tag}]`, x.slice(0, 220)) })
  page.on('response', (r) => { if (r.status() >= 400 && !/40392/.test(r.url())) console.log(ts(), `[${tag} http]`, r.status(), r.url().slice(0, 120)) })
  page.on('pageerror', (e) => console.log(ts(), `[${tag} pageerror]`, e.message))
}
const luminance = (page) => page.evaluate(() => {
  const c = document.querySelector('.live-stage canvas')
  if (!c || !c.width) return { w: 0, h: 0, mean: -1 }
  const off = document.createElement('canvas'); off.width = 64; off.height = 36
  const g = off.getContext('2d'); g.drawImage(c, 0, 0, 64, 36)
  const d = g.getImageData(0, 0, 64, 36).data; let s = 0
  for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3
  return { w: c.width, h: c.height, mean: +(s / (d.length / 4)).toFixed(1), badge: document.querySelector('.live-stage.is-live') !== null }
})
const host = await (await context()).newPage(); wire(host, 'host')
await host.goto(base)
await host.getByRole('button', { name: /YouTube/i }).first().click()
await host.getByRole('textbox').first().fill(link)
await host.getByRole('button', { name: /Buscar vídeo/i }).click()
await host.getByText('AO VIVO').first().waitFor({ timeout: 150_000 })
console.log(ts(), 'summary says AO VIVO')
await host.getByRole('button', { name: /Criar sala/i }).click()
await host.locator('#nickname').fill('host')
await host.getByRole('button', { name: /Criar sala/i }).click()
await host.waitForURL(/\/room\//, { timeout: 60_000 })
const roomID = host.url().split('/room/')[1].split(/[?#]/)[0]
console.log(ts(), 'room', roomID)
const info = async () => (await fetch(`${base}/api/rooms/${roomID}`)).json()
const until = async (name, pred, ms = 180_000) => { const s = Date.now(); while (Date.now() - s < ms) { const i = await info(); if (pred(i)) return i; await new Promise((r) => setTimeout(r, 1500)) }; throw new Error('timeout: ' + name + ' ' + JSON.stringify(await info())) }
let i = await until('live source', (i) => i.sourceKind === 'live')
console.log(ts(), 'room is live source, producer', i.live?.producer, 'status', i.status)
i = await until('ready', (i) => i.status === 'ready' || i.status === 'error', 240_000)
console.log(ts(), 'status', i.status, i.errorMessage ?? '')
if (i.status !== 'ready') throw new Error('live never became ready: ' + i.errorMessage)
const guest = await (await context()).newPage(); wire(guest, 'guest')
await guest.goto(`${base}/room/${roomID}`)
await guest.fill('#join-nickname', 'guest')
await guest.getByRole('button', { name: 'Entrar na sala' }).click()
await guest.locator('.live-stage').waitFor({ timeout: 30_000 })
for (let n = 0; n < 12; n++) {
  await guest.waitForTimeout(2500)
  const h = await luminance(host); const g = await luminance(guest)
  console.log(ts(), 'host', JSON.stringify(h), 'guest', JSON.stringify(g))
  if (h.mean > 3 && g.mean > 3) break
}
let g = await luminance(guest)
if (!(g.mean > 3 && g.badge)) throw new Error('guest never saw the live: ' + JSON.stringify(g))
await guest.getByRole('button', { name: /Ir para o vivo/ }).click()
for (let n = 0; n < 10; n++) { await guest.waitForTimeout(2000); g = await luminance(guest); if (g.mean > 3 && g.badge) break }
console.log(ts(), 'after jump', JSON.stringify(g))
if (!(g.mean > 3 && g.badge)) throw new Error('guest lost the live after the jump: ' + JSON.stringify(g))
console.log(ts(), 'LIVE OK producer=' + (await info()).live?.producer)
await browser.close()
