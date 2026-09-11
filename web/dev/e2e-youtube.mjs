// A YouTube link end to end: the host pastes it, confirms the video, the room becomes
// ready from the backend's production (fleet or jlocal), audio tracks and subtitles
// arrive, and a cold seek lands in a new region. Needs the local stack (server :8090,
// a worker with yt-dlp, or jlocal with tools). Run from a directory with playwright:
//   BASE=http://127.0.0.1:8090 node web/dev/e2e-youtube.mjs
import { createRequire } from 'node:module'
const PW = process.env.PW ?? '/private/tmp/claude-501/-Users-giuli-projects-ss/d8b553fd-51c4-4852-9df5-bc6f63c5e1a2/scratchpad/pw/package.json'
const { chromium } = createRequire(PW)('playwright')
const base = process.env.BASE ?? 'http://127.0.0.1:8090'
const link = process.env.LINK ?? 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
const OUT = new URL('.', import.meta.url).pathname
const browser = await chromium.launch({ channel: 'chrome', args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR' })
await ctx.addInitScript(() => { try { localStorage.setItem('ss.onboarding.v1', '1'); localStorage.setItem('ss.codec-notice.v1', '1') } catch {} })
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error' || /youtube|pipeline|failed/i.test(m.text())) console.log('[console]', m.text().slice(0, 200)) })
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url().slice(0, 120)) })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
const shot = (name) => page.screenshot({ path: `${OUT}yt-${name}.png` })

await page.goto(base)
await page.getByRole('button', { name: /YouTube/i }).first().click()
await page.locator('#youtube-link').fill(link)
await page.getByRole('button', { name: /Buscar vídeo|Find video/i }).click()
await page.getByRole('button', { name: /Criar sala|Create room/i }).first().click({ timeout: 180_000 })
await shot('confirm')
await page.locator('#nickname').fill('giuli')
await page.getByRole('button', { name: /Criar sala|Create room/i }).last().click()
await page.waitForURL(/\/room\//, { timeout: 60_000 })
const roomID = page.url().split('/room/')[1].split(/[?#]/)[0]
console.log('room', roomID)
const info = async () => (await fetch(`${base}/api/rooms/${roomID}`)).json()
const until = async (name, pred, ms = 120_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const i = await info(); if (pred(i)) return i; await new Promise((r) => setTimeout(r, 1500)) }; throw new Error('timeout: ' + name + ' last=' + JSON.stringify(await info()).slice(0, 400)) }
const video = () => page.evaluate(() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, rs: v.readyState, paused: v.paused, dur: v.duration } : null })
const regions = (i) => (i.mediaRegions ?? []).map((r) => `r${r.n}@${(r.startMs / 1000).toFixed(1)}+${(r.producedMs / 1000).toFixed(0)}${r.growing ? '*' : ''}`).join(' ')
const seekTo = (seconds) => page.evaluate((s) => {
  const input = document.querySelector('input[type=range]')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, String(s))
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}, seconds)

let i = await until('ready', (i) => i.status === 'ready' || i.status === 'error', 300_000)
if (i.status === 'error') { console.log('ROOM ERROR', i.errorMessage); await shot('error'); process.exit(1) }
console.log('READY', i.fileName, 'origin', i.sourceOrigin, 'duration', i.durationMs, 'regions', regions(i))
console.log('audio tracks', JSON.stringify(i.audioTracks), 'subtitles', (i.subtitleTracks ?? []).map((t) => t.language + (t.title ? `:${t.title}` : '')).join(', '), 'chapters', (i.chapters ?? []).length)
await page.getByRole('button', { name: /play|reproduzir|tocar/i }).first().click().catch(() => {})
await page.waitForTimeout(8000)
console.log('playing:', JSON.stringify(await video()))
await shot('playing')

const target = Math.min(Math.floor(i.durationMs / 1000 * 0.7), 600)
await seekTo(target)
i = await until('region near seek', (i) => (i.mediaRegions ?? []).some((r) => Math.abs(r.startMs - target * 1000) < 20_000 && r.producedMs >= 4000), 180_000)
await page.waitForTimeout(8000)
console.log('after cold seek', target, 'regions', regions(i), 'video', JSON.stringify(await video()))
await shot('seek')
i = await until('subtitles', (i) => (i.subtitleTracks ?? []).length > 0, 60_000).catch(() => info())
console.log('final subtitles', (i.subtitleTracks ?? []).length, 'complete?', i.status, regions(i))
await browser.close()
