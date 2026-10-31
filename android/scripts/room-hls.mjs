// A room of the local stack with a video in it, for :player's RoomHlsTest. Prints the master
// URL as the emulator sees it and keeps the host's page open for HOLD_S seconds.
//   PW=<dir>/package.json VIDEO=<file.mp4> node android/scripts/room-hls.mjs
import { createRequire } from 'node:module'
const { chromium } = createRequire(process.env.PW)('playwright')
const base = process.env.BASE ?? 'http://127.0.0.1:8090'
const video = process.env.VIDEO
const hold = Number(process.env.HOLD_S ?? 900)
if (!video) throw new Error('VIDEO is required')

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ locale: 'pt-BR' })
await ctx.addInitScript(() => { try { localStorage.setItem('ss.onboarding.v1', '1'); localStorage.setItem('ss.onboarding.v2', '1'); localStorage.setItem('ss.codec-notice.v1', '1') } catch {} })
const host = await ctx.newPage()
await host.goto(base)
// The codec notice keys its dismissal on the codecs this browser lacks, so it is closed rather than pre-dismissed.
await host.locator('.codec-dialog').waitFor({ timeout: 5_000 }).then(() => host.keyboard.press('Escape')).catch(() => {})
await host.getByRole('button', { name: /Criar sala/ }).first().click()
await host.getByRole('button', { name: /Continuar sem conta/ }).click()
await host.getByRole('button', { name: /^Entrar$/ }).click()
await host.waitForURL(/\/room\//, { timeout: 60_000 })
const roomID = host.url().split('/room/')[1].split(/[?#]/)[0]
await host.getByRole('button', { name: 'Compartilhar' }).click()
const [chooser] = await Promise.all([host.waitForEvent('filechooser'), host.getByRole('menuitem', { name: 'Arquivo de vídeo' }).click()])
await chooser.setFiles(video)
const t0 = Date.now()
let info
while (Date.now() - t0 < 240_000) {
  info = await (await fetch(`${base}/api/rooms/${roomID}`)).json()
  if (info.status === 'ready') break
  await new Promise((r) => setTimeout(r, 1000))
}
if (info?.status !== 'ready') throw new Error('room never got ready: ' + JSON.stringify(info).slice(0, 300))
const emu = (url) => url.replace(/\/\/(127\.0\.0\.1|localhost)/, '//10.0.2.2')
const region = info.mediaRegions?.[0]
const master = `${base}/media/${roomID}/hls/${region ? `r${region.n}_` : ''}master.m3u8`
console.log(JSON.stringify({ room: roomID, master: emu(master), regions: info.mediaRegions ?? null }))
await new Promise((r) => setTimeout(r, hold * 1000))
await browser.close()
