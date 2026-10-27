// Stages side by side: the host opens a file, a guest asks to share a
// screen, the host says yes, and the screen plays beside the media; the host
// then swaps the media and the guest's screen stays up through it. Needs the
// native local stack (see the e2e-local memory) with the MoQ relay variables,
// and PW pointing at a playwright install.
// VIDEO=a.mp4 VIDEO2=b.mp4 BASE=http://127.0.0.1:8092 PW=/tmp/pw/package.json node e2e-stages.mjs
import { createRequire } from 'node:module'
const { chromium } = createRequire(process.env.PW ?? '/private/tmp/ss-debug/package.json')('playwright')
const base = process.env.BASE ?? 'http://127.0.0.1:8092'
const video = process.env.VIDEO
const video2 = process.env.VIDEO2 ?? video
if (!video) throw new Error('VIDEO is required')

const fakeDisplay = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640; canvas.height = 360
    canvas.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(canvas)
    const ctx = canvas.getContext('2d')
    let i = 0
    setInterval(() => {
      ctx.fillStyle = `hsl(${(i * 7) % 360},80%,50%)`
      ctx.fillRect(0, 0, 640, 360)
      ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif'
      ctx.fillText('frame ' + i, 40, 200)
      i += 1
    }, 100)
    return canvas.captureStream(30)
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const newPage = async (who) => {
  const ctx = await browser.newContext({ locale: 'pt-BR' })
  await ctx.addInitScript(() => { try { localStorage.setItem('ss.onboarding.v1', '1'); localStorage.setItem('ss.onboarding.v2', '1'); localStorage.setItem('ss.codec-notice.v1', '1') } catch {} })
  await ctx.addInitScript(fakeDisplay)
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${who} console]`, m.text().slice(0, 200)) })
  page.on('response', (r) => { if (r.status() >= 400 && !/manifest|\.m3u8/.test(r.url())) console.log(`[${who} http]`, r.status(), r.url().slice(0, 120)) })
  page.on('pageerror', (e) => console.log(`[${who} pageerror]`, e.message))
  return page
}
const check = (name, ok, detail = '') => { console.log(ok ? 'OK  ' : 'FAIL', name, detail); if (!ok) process.exitCode = 1 }

const host = await newPage('host')
await host.goto(base)
await host.locator('input[type=file][accept="video/*,.mkv"]').setInputFiles(video)
await host.locator('#nickname').fill('host')
await host.getByRole('button', { name: /Criar sala|Create room/i }).click()
await host.waitForURL(/\/room\//, { timeout: 60_000 })
const roomID = host.url().split('/room/')[1].split(/[?#]/)[0]
const info = async () => (await fetch(`${base}/api/rooms/${roomID}`)).json()
const until = async (name, pred, ms = 120_000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const i = await info(); if (pred(i)) return i; await new Promise((r) => setTimeout(r, 500)) }
  throw new Error('timeout: ' + name + ' ' + JSON.stringify(await info()).slice(0, 400))
}
let room = await until('media ready', (i) => i.status === 'ready', 180_000)
check('the room opened the file after being born empty', room.mediaGeneration === 1 && room.fileName !== '', `gen=${room.mediaGeneration} file=${room.fileName}`)
check('the room has no kind any more', !('sourceKind' in room) && !('screenShareOpen' in room))

const guest = await newPage('guest')
await guest.goto(`${base}/room/${roomID}`)
await guest.fill('#join-nickname', 'guest')
await guest.getByRole('button', { name: /Entrar na sala|Join room/i }).click()
await guest.getByRole('button', { name: /Pedir ao anfitrião|Ask the host/i }).click()
await guest.locator('[data-stage-ask="screen"]').click()

const card = host.locator('[data-stage-request="screen"]')
await card.waitFor({ timeout: 15_000 })
check('the host sees the guest asking for a screen', (await card.textContent()).includes('guest'))
await card.getByRole('button', { name: /Deixar|Allow/i }).click()

await guest.getByRole('button', { name: /Compartilhar minha tela|Share my screen/i }).click({ timeout: 15_000 })
room = await until('guest screen up', (i) => (i.screens ?? []).length === 1, 40_000)
check('the guest shares a screen beside the media', room.screens[0].nickname === 'guest' && room.status === 'ready')
await host.locator('.screen-tile').first().waitFor({ timeout: 30_000 })
check('the host sees the screen and the player at once', await host.locator('video').count() > 0 && await host.locator('.screen-tile').count() === 1)
await host.screenshot({ path: new URL('stages-1.png', import.meta.url).pathname })

// The host swaps the media; the screen must stay up the whole way through.
let dropped = false
const watching = (async () => {
  for (let n = 0; n < 240 && !dropped; n++) {
    const i = await info()
    if ((i.screens ?? []).length !== 1) dropped = true
    if (i.mediaGeneration === 2 && i.status === 'ready') return
    await new Promise((r) => setTimeout(r, 500))
  }
})()
await host.locator('input[type=file][accept="video/*,.mkv"]').setInputFiles(video2)
room = await until('second media ready', (i) => i.mediaGeneration === 2 && i.status === 'ready', 180_000)
await watching
check('swapping the media leaves the screen up', !dropped && (room.screens ?? []).length === 1)
await guest.waitForTimeout(2000)
check('the guest still publishes after the swap', await guest.getByRole('button', { name: /Parar de compartilhar|Stop sharing/i }).count() === 1)
await host.screenshot({ path: new URL('stages-2.png', import.meta.url).pathname })

await guest.getByRole('button', { name: /Parar de compartilhar|Stop sharing/i }).click()
room = await until('screen down', (i) => (i.screens ?? []).length === 0, 20_000)
check('the media plays on after the screen goes', room.status === 'ready' && room.mediaGeneration === 2)

await browser.close()
console.log(process.exitCode ? 'failed' : 'done')
