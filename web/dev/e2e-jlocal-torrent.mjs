// A torrent prepared by jlocal end to end: the host opens the magnet with the companion
// app connected, the room is produced on the host's machine (no /api/torrents, no worker
// probes), a guest watches, a cold seek lands in a new region, and the ASS subtitles and
// chapters of the file reach the room and render for the guest. Needs the local stack
// (server :8090, MinIO) and jlocal on 127.0.0.1:40392 with the tools installed and
// JLOCAL_ALLOWED_ORIGINS=http://127.0.0.1:8090. Run with:
//   PW=<dir with playwright>/package.json BASE=http://127.0.0.1:8090 node web/dev/e2e-jlocal-torrent.mjs
// REFUSE_RUN=1 makes jlocal refuse the first run, so the room must fall to the fleet (needs a
// worker running) after the magnet was listed by jlocal.
import { createRequire } from 'node:module'
const PW = process.env.PW ?? '/private/tmp/claude-501/-Users-giuli-projects-ss/b4ee052c-aae2-41fc-b08d-a70ef47c3422/scratchpad/pw/package.json'
const { chromium } = createRequire(PW)('playwright')
const base = process.env.BASE ?? 'http://127.0.0.1:8090'
const magnet = process.env.MAGNET ?? 'magnet:?xt=urn:btih:1b18ad819975895766adfccf930c2b2facb0a48a'
const OUT = process.env.OUT ?? new URL('.', import.meta.url).pathname
const browser = await chromium.launch({ channel: 'chrome', args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'] })
const check = (name, ok) => { console.log(ok ? 'OK  ' : 'FAIL', name); if (!ok) process.exitCode = 1 }

const fleetCalls = []
const newPage = async (who) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR' })
  await ctx.addInitScript(() => { try { localStorage.setItem('ss.onboarding.v1', '1'); localStorage.setItem('ss.codec-notice.v1', '1') } catch {} })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error' || /jlocal|torrent|failed/i.test(m.text())) console.log(`[${who} console]`, m.text().slice(0, 200)) })
  page.on('response', (r) => { if (r.status() >= 400 && !/\.m3u8/.test(r.url())) console.log(`[${who} http]`, r.status(), r.url().slice(0, 120)) })
  page.on('request', (r) => { if (/\/api\/torrents/.test(r.url())) fleetCalls.push(r.url()) })
  page.on('pageerror', (e) => console.log(`[${who} pageerror]`, e.message))
  return page
}
const shot = (page, name) => page.screenshot({ path: `${OUT}jlocal-torrent-${name}.png` })

const refuse = process.env.REFUSE_RUN === '1'
const host = await newPage('host')
if (refuse) await host.route('**/torrent/run', (route) => route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base }, body: '{"error":"remux_busy"}' }))
await host.goto(base)
await host.getByRole('button', { name: /torrent/i }).first().click()
await host.locator('#magnet-link').fill(magnet)
const t0 = Date.now()
await host.getByRole('button', { name: /Buscar arquivos|Find files/i }).click()
const file = host.locator('.torrent-files button').first()
await file.waitFor({ timeout: 180_000 })
console.log('listed in', Date.now() - t0, 'ms:', await file.innerText())
check('no worker probes shown', await host.locator('.worker-probes').count() === 0)
await file.click()
await host.locator('#nickname').fill('host')
await host.getByRole('button', { name: /Criar sala|Create room/i }).click()
await host.waitForURL(/\/room\//, { timeout: 60_000 })
const roomID = host.url().split('/room/')[1].split(/[?#]/)[0]
console.log('room', roomID)

const info = async () => (await fetch(`${base}/api/rooms/${roomID}`)).json()
const until = async (name, pred, ms = 120_000) => { const t = Date.now(); while (Date.now() - t < ms) { const i = await info(); if (pred(i)) return i; await new Promise((r) => setTimeout(r, 1500)) }; throw new Error('timeout: ' + name + ' last=' + JSON.stringify(await info()).slice(0, 400)) }
const regions = (i) => (i.mediaRegions ?? []).map((r) => `r${r.n}@${(r.startMs / 1000).toFixed(1)}+${(r.producedMs / 1000).toFixed(0)}${r.growing ? '*' : ''}`).join(' ')
const video = (page) => page.evaluate(() => { const v = document.querySelector('video'); return v ? { t: +v.currentTime.toFixed(2), rs: v.readyState, paused: v.paused, dur: v.duration } : null })
const seekTo = (page, seconds) => page.evaluate((s) => {
  const input = document.querySelector('input[type=range]')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, String(s))
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}, seconds)

let i = await until('ready', (i) => i.status === 'ready' || i.status === 'error', 300_000)
if (i.status === 'error') { console.log('ROOM ERROR', i.errorMessage); await shot(host, 'error'); process.exit(1) }
console.log('READY in', Date.now() - t0, 'ms', i.fileName, 'duration', i.durationMs, 'regions', regions(i))
if (refuse) check('jlocal refused, the fleet took the file: ' + fleetCalls.length, fleetCalls.some((url) => /\/remux$/.test(url)))
else check('the fleet was never asked: ' + JSON.stringify(fleetCalls), fleetCalls.length === 0)

const guest = await newPage('guest')
await guest.goto(`${base}/room/${roomID}`)
await guest.fill('#join-nickname', 'guest')
await guest.getByRole('button', { name: 'Entrar na sala' }).click()
await guest.locator('video').waitFor({ timeout: 60_000 })
await host.getByRole('button', { name: /play|reproduzir|tocar/i }).first().click().catch(() => {})
await guest.waitForTimeout(10_000)
const g1 = await video(guest)
await guest.waitForTimeout(3_000)
const g2 = await video(guest)
console.log('guest playing:', JSON.stringify(g1), '->', JSON.stringify(g2))
check('guest plays from the start', g2 && g2.rs >= 2 && g2.t > g1.t)
await shot(guest, 'playing')

i = await until('subtitles and chapters', (i) => (i.subtitleTracks ?? []).length > 0 && (i.chapters ?? []).length > 0, 120_000).catch(() => info())
console.log('subtitles', (i.subtitleTracks ?? []).length, (i.subtitleTracks ?? []).slice(0, 6).map((t) => `${t.language}:${t.codec}`).join(', '), 'chapters', (i.chapters ?? []).length)
check('subtitle tracks reached the room', (i.subtitleTracks ?? []).length > 0)
check('chapters reached the room', (i.chapters ?? []).length > 0)

const durationS = Math.floor((i.durationMs || 1_400_000) / 1000)
const target = Math.floor(durationS * 0.7)
const seekAt = Date.now()
await seekTo(host, target)
i = await until('region near the seek', (i) => (i.mediaRegions ?? []).some((r) => r.n > 0 && Math.abs(r.startMs - target * 1000) < 20_000 && r.producedMs >= 4000), 180_000)
console.log('cold seek to', target, 's produced a region in', Date.now() - seekAt, 'ms:', regions(i))
await guest.waitForTimeout(10_000)
const s1 = await video(guest)
await guest.waitForTimeout(3_000)
const s2 = await video(guest)
// A region's video starts at its own zero; the room's offset places it.
const offset = ((await info()).mediaOffsetMs ?? 0) / 1000
console.log('guest after seek:', JSON.stringify(s1), '->', JSON.stringify(s2), 'offset', offset)
check('guest plays past the cold seek', s2 && s2.rs >= 2 && s2.t > s1.t && Math.abs(s2.t + offset - target) < 60)

await guest.locator('video').hover()
await guest.getByRole('button', { name: /Configurações|Settings/i }).click({ force: true })
await guest.getByRole('button', { name: /^Legendas/ }).click()
const rows = await guest.getByTestId('setting-subtitles').getByRole('button').allInnerTexts()
console.log('guest subtitle rows:', rows.length, JSON.stringify(rows.slice(0, 5)))
const track = guest.getByTestId('setting-subtitles').getByRole('button').filter({ hasNotText: /Importar|Desligad|Nenhum|Off/i }).first()
await track.click()
await guest.keyboard.press('Escape').catch(() => {})
await guest.waitForTimeout(6_000)
const layer = await guest.evaluate(() => ({ ass: !!document.querySelector('.ass-layer'), cues: Array.from(document.querySelector('video').textTracks).filter((t) => t.mode !== 'disabled').length }))
console.log('guest subtitle render:', JSON.stringify(layer))
check('guest renders a subtitle track', layer.ass || layer.cues > 0)
await shot(guest, 'subtitles')
if (refuse) { await browser.close(); process.exit() }

// The host reloads and seeks where nothing was produced: the tab picks the
// preparo back up from the remembered magnet, through jlocal again.
const before = await info()
await host.reload()
// The room reads a producer as gone after 90 s without a heartbeat.
await until('producer gone', (i) => i.producerHeartbeatMs === undefined || Date.now() - i.producerHeartbeatMs > 95_000, 400_000)
const held = (await info()).mediaRegions ?? []
const r0 = held.find((r) => r.n === 0)
const r1 = held.find((r) => r.n === 1)
const gap = Math.floor((r0.startMs + r0.producedMs + r1.startMs) / 2000)
console.log('seeking into the gap at', gap, 's:', regions(await info()))
await host.locator('video').waitFor({ timeout: 60_000 })
await seekTo(host, gap)
i = await until('resumed generation ready', (i) => i.mediaGeneration > before.mediaGeneration && i.status === 'ready', 240_000)
console.log('resumed: generation', before.mediaGeneration, '->', i.mediaGeneration, 'regions', regions(i))
check('resume went through jlocal, never the fleet: ' + JSON.stringify(fleetCalls), fleetCalls.length === 0)
await browser.close()
