import { createRequire } from 'node:module'
const { chromium } = createRequire('/private/tmp/ss-debug/package.json')('playwright')
const base = 'http://127.0.0.1:8090'
const magnet = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel'
const browser = await chromium.launch({ channel: 'chrome', args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR' })
await ctx.addInitScript(() => { try { localStorage.setItem('ss.onboarding.v1', '1'); localStorage.setItem('ss.codec-notice.v1', '1') } catch {} })
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error' || /remux-worker|pipeline|trouble|failed/.test(m.text())) console.log('[console]', m.text().slice(0, 200)) })
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url().slice(0, 120)) })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(base)
await page.getByRole('button', { name: /torrent/i }).first().click()
await page.getByRole('textbox').first().fill(magnet)
await page.getByRole('button', { name: /Buscar arquivos|Find files/i }).click()
await page.getByRole('button', { name: /Sintel\.mp4/ }).click({ timeout: 120_000 })
await page.locator('#nickname').fill('giuli')
await page.getByRole('button', { name: /Criar sala|Create room/i }).click()
await page.waitForURL(/\/room\//, { timeout: 60_000 })
const roomID = page.url().split('/room/')[1].split(/[?#]/)[0]
const info = async () => (await fetch(`${base}/api/rooms/${roomID}`)).json()
const until = async (name, pred, ms = 120_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const i = await info(); if (pred(i)) return i; await new Promise((r) => setTimeout(r, 1500)) }; throw new Error('timeout: ' + name) }
const video = () => page.evaluate(() => { const v = document.querySelector('video'); return { t: v.currentTime, rs: v.readyState, paused: v.paused, dur: v.duration } })
const seekTo = async (seconds) => {
  // Set through the native setter so React sees the change.
  await page.evaluate((s) => {
    const input = document.querySelector('input[type=range]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, String(s))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, seconds)
}
const regions = (i) => (i.mediaRegions ?? []).map((r) => `r${r.n}@${(r.startMs / 1000).toFixed(1)}+${(r.producedMs / 1000).toFixed(0)}${r.growing ? '*' : ''}`).join(' ')

let i = await until('ready', (i) => i.status === 'ready', 300_000)
console.log('READY regions:', regions(i), 'swarm', JSON.stringify(i.preparation?.swarm))
await page.getByRole('button', { name: /play|reproduzir|tocar/i }).first().click().catch(() => {})
await page.waitForTimeout(6000)
console.log('playing from start:', JSON.stringify(await video()))

await seekTo(600)
i = await until('region near 600', (i) => (i.mediaRegions ?? []).some((r) => Math.abs(r.startMs - 600_000) < 15_000 && r.producedMs >= 4000), 180_000)
console.log('after seek 600 regions:', regions(i))
await page.waitForTimeout(8000)
let v = await video()
console.log('video after cold seek:', JSON.stringify(v), 'offset region:', regions(await info()))
const have = (await info()).preparation?.swarm
console.log('swarm at that point:', JSON.stringify(have), 'fraction', (have.haveBytes / have.selectedBytes).toFixed(2))

const before = (await info()).mediaRegions.length
await seekTo(20)
await page.waitForTimeout(8000)
i = await info()
v = await video()
console.log('after seek 20 regions:', regions(i), 'count', before, '->', i.mediaRegions.length, 'video', JSON.stringify(v))

for (const s of [300, 420, 200, 480, 360]) { await seekTo(s); await page.waitForTimeout(700) }
i = await until('region near 360', (i) => (i.mediaRegions ?? []).some((r) => Math.abs(r.startMs - 360_000) < 15_000 && r.growing), 180_000)
await page.waitForTimeout(8000)
console.log('after storm regions:', regions(await info()), 'video', JSON.stringify(await video()), 'status', (await info()).status)
await page.screenshot({ path: process.env.SHOT ?? 'e2e-seek.png' })
await browser.close()
