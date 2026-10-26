// Camera and voice end to end over the real MoQ relay: a host and a guest join one room
// through dev/call.html (useCall + CallVideo on the real socket), switch on fake cameras and
// microphones, and each must see the other's picture and light up when the other speaks.
// Then the host mutes the guest and turns the guest's camera off: the guest's devices go
// off, the room says so, and the host stops hearing and painting them.
//
// Needs the Go server running with a MoQ relay configured (BASE, default http://127.0.0.1:8091).
// Serves the harness from its own Vite, proxied to BASE.
//
//   BASE=http://127.0.0.1:8091 PW=<dir with playwright> node dev/e2e-call.mjs

import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.resolve(here, '..')
const BASE = process.env.BASE ?? 'http://127.0.0.1:8091'
const OUT = here + '/'
const require = createRequire(path.join(process.env.PW ?? web, 'package.json'))
const { chromium } = require('playwright')
const { createServer } = await import(path.join(web, 'node_modules/vite/dist/node/index.js'))

// Speech-like bursts for the fake microphone: 300 ms of a 300 Hz tone every second.
const RATE = 48000
const samples = new Int16Array(RATE * 4)
for (let k = 0; k < 4; k++) {
  for (let i = 0; i < RATE * 0.3; i++) samples[k * RATE + i] = Math.round(Math.sin(2 * Math.PI * 300 * i / RATE) * 0.6 * 32767)
}
const wav = Buffer.alloc(44 + samples.byteLength)
wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples.byteLength, 4); wav.write('WAVE', 8)
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(samples.byteLength, 40)
Buffer.from(samples.buffer).copy(wav, 44)
const wavPath = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-call-')), 'voice.wav')
writeFileSync(wavPath, wav)

const vite = await createServer({
  root: web,
  configFile: path.join(web, 'vite.config.ts'),
  server: { port: 5192, strictPort: true, proxy: { '/api': BASE, '/ws': { target: BASE.replace(/^http/, 'ws'), ws: true } } },
})
await vite.listen()
const HARNESS = 'http://localhost:5192/dev/call.html'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`],
})
const until = async (what, check, ms = 30000) => {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    last = await check()
    if (last) return last
    await new Promise((f) => setTimeout(f, 300))
  }
  throw new Error(`timed out waiting for ${what}`)
}
const open = async (tag, query) => {
  const page = await (await browser.newContext()).newPage()
  page.on('pageerror', (e) => console.log(`[${tag}] pageerror`, e.message))
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${tag}]`, m.text().slice(0, 300)) })
  await page.goto(`${HARNESS}?${new URLSearchParams(query)}`)
  await page.waitForFunction(() => window.callState?.memberId, null, { timeout: 20000 })
  pages.push([tag, page])
  return page
}
const state = (page) => page.evaluate(() => window.callState)
const luminance = (page, memberId) => page.evaluate((id) => {
  const canvas = document.querySelector(`.tile[data-member="${id}"] canvas`)
  if (!canvas || !canvas.width) return 0
  const small = document.createElement('canvas'); small.width = 32; small.height = 18
  const ctx = small.getContext('2d'); ctx.drawImage(canvas, 0, 0, 32, 18)
  const px = ctx.getImageData(0, 0, 32, 18).data
  let sum = 0
  for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3
  return Math.round(sum / (px.length / 4))
}, memberId)
const pages = []
const shot = (page, name) => page.screenshot({ path: OUT + 'call-' + name + '.png' })

try {
  const created = await (await fetch(`${BASE}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'host', kind: 'screen' }),
  })).json()
  console.log('room', created.id)
  const host = await open('host', { room: created.id, nickname: 'host', owner: created.ownerToken })
  const guest = await open('guest', { room: created.id, nickname: 'guest' })
  const hostId = (await state(host)).memberId
  const guestId = (await state(guest)).memberId

  for (const page of [host, guest]) {
    await page.click('#mic')
    await page.click('#cam')
  }
  await until('both members on with mic and cam', async () => {
    const members = (await state(host)).members
    return members.length === 2 && members.every((m) => m.mic && m.cam)
  })

  const hostSeen = await until("guest painting the host's camera", async () => { const l = await luminance(guest, hostId); return l > 10 && l }, 40000)
  const guestSeen = await until("host painting the guest's camera", async () => { const l = await luminance(host, guestId); return l > 10 && l }, 40000)
  console.log('cameras painted, mean luminance:', { hostSeen, guestSeen })

  await until('the guest seeing the host speak', async () => (await state(guest)).speaking[hostId] === true, 20000)
  await until('the host seeing the guest speak', async () => (await state(host)).speaking[guestId] === true, 20000)
  await until('the host seeing their own ring', async () => (await state(host)).speaking[hostId] === true, 20000)
  console.log('speaking rings: yes')
  await shot(host, 'host-1')
  await shot(guest, 'guest-1')

  await host.click(`.tile[data-member="${guestId}"] .mute`)
  await until('the guest muted by the host', async () => {
    const s = await state(guest)
    return !s.mic && s.forced.mic && s.cam
  })
  await until('the host letting go of the guest voice', async () => {
    const s = await state(host)
    const member = s.members.find((m) => m.id === guestId)
    return member.hostMuted && !member.mic && s.speaking[guestId] === undefined
  })
  console.log('host mute: yes')

  await host.click(`.tile[data-member="${guestId}"] .camoff`)
  await until('the guest camera turned off by the host', async () => {
    const s = await state(guest)
    return !s.cam && s.forced.cam
  })
  await until("the host's tile for the guest without a picture", async () => {
    return (await host.locator(`.tile[data-member="${guestId}"] canvas`).count()) === 0
  })
  console.log('host cam off: yes')

  // Turning the microphone back on is the guest's own call.
  await guest.click('#mic')
  await until('the guest back on the microphone', async () => {
    const member = (await state(host)).members.find((m) => m.id === guestId)
    return member.mic && !member.hostMuted
  })
  await until('the host hearing the guest again', async () => (await state(host)).speaking[guestId] === true, 20000)
  console.log('unmute after host mute: yes')
  await shot(host, 'host-2')
  console.log('done')
} catch (failure) {
  for (const [tag, page] of pages) console.log(tag, JSON.stringify(await state(page)))
  throw failure
} finally {
  await browser.close()
  await vite.close()
}
