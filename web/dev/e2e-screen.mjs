// Screen share end to end: a host and a guest publish synthetic screens (canvas + oscillator) to
// the MoQ relay, each must see the other's tile paint, and the host's "anyone can share" switch
// must take the guest's screen down without touching the host's own.
// Run from a directory with playwright installed: BASE=https://juntos.lol node e2e-screen.mjs

import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8080'
const OUT = new URL('.', import.meta.url).pathname
const shot = (page, name) => page.screenshot({ path: OUT + (process.env.TAG ?? '') + name + '.png' })

const skipOverlays = () => {
  try { localStorage.setItem('ss.onboarding.v1', '1') } catch {}
  try { localStorage.setItem('ss.codec-notice.v1', '1') } catch {}
}

const fakeDisplay = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640; canvas.height = 360
    canvas.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(canvas)
    const ctx = canvas.getContext('2d')
    const hue = Number(localStorage.getItem('e2e.hue') ?? '0')
    let i = 0
    setInterval(() => {
      ctx.fillStyle = `hsl(${(hue + i * 7) % 360},80%,50%)`
      ctx.fillRect(0, 0, 640, 360)
      ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif'
      ctx.fillText('frame ' + i, 40, 200)
      i += 1
    }, 100)
    const stream = canvas.captureStream(30)
    try {
      const ac = new AudioContext()
      const osc = ac.createOscillator(); osc.frequency.value = 440
      const dest = ac.createMediaStreamDestination()
      osc.connect(dest); osc.start()
      const [audio] = dest.stream.getAudioTracks()
      if (audio) stream.addTrack(audio)
    } catch (e) { console.log('fake audio failed', String(e)) }
    return stream
  }
}

const room = async (id) => (await fetch(`${BASE}/api/rooms/${id}`)).json()
const waitScreens = async (id, want, ms = 40000) => {
  const until = Date.now() + ms
  let last = null
  while (Date.now() < until) {
    const r = await room(id)
    last = r.screens ?? []
    if (last.length === want) return r
    await new Promise((f) => setTimeout(f, 500))
  }
  throw new Error(`room never had ${want} screens (last: ${JSON.stringify(last)})`)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const wire = (page, tag) => {
  page.on('console', (m) => { const t = m.text(); if (/moq|relay|screen|error|warn|WebTransport|catalog/i.test(t)) console.log(`[${tag}]`, m.type(), t.slice(0, 300)) })
  page.on('pageerror', (e) => console.log(`[${tag}] pageerror`, e.message))
}
const newPage = async (tag, hue) => {
  const context = await browser.newContext({ locale: 'pt-BR' })
  await context.addInitScript(skipOverlays)
  await context.addInitScript(`try { localStorage.setItem('e2e.hue', '${hue}') } catch {}`)
  await context.addInitScript(fakeDisplay)
  const page = await context.newPage()
  wire(page, tag)
  return page
}

const tiles = (page) => page.locator('.screen-tile')
const probe = async (page) => page.evaluate(() => [...document.querySelectorAll('.screen-tile')].map((tile) => {
  // Mean luminance of a downscale: a decoded picture is well above black.
  const luminance = (canvas) => {
    const small = document.createElement('canvas'); small.width = 64; small.height = 36
    const ctx = small.getContext('2d'); ctx.drawImage(canvas, 0, 0, 64, 36)
    const px = ctx.getImageData(0, 0, 64, 36).data
    let sum = 0
    for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3
    return Math.round(sum / (px.length / 4))
  }
  const canvas = tile.querySelector('canvas')
  return {
    label: tile.querySelector('.screen-tile-label')?.textContent ?? '',
    state: tile.querySelector('.screen-tile-state')?.textContent ?? '',
    live: canvas ? { w: canvas.width, h: canvas.height, bytes: canvas.toDataURL('image/png').length, mean: luminance(canvas) } : 'local preview',
    frozen: canvas?.className ?? '',
  }
}))

const host = await newPage('host', 0)
await host.goto(BASE)
await host.getByRole('button', { name: 'Compartilhar sua tela' }).click()
await host.fill('#nickname', 'host')
await host.getByRole('button', { name: 'Criar sala' }).click()
await host.waitForURL(/\/room\//, { timeout: 20000 })
const roomId = host.url().split('/room/')[1].split(/[/?#]/)[0]
console.log('room', roomId)
await waitScreens(roomId, 1)
console.log('host live: yes')
await shot(host, 'host-1')

const guest = await newPage('guest', 180)
await guest.goto(`${BASE}/room/${roomId}`)
await guest.fill('#join-nickname', 'guest')
await guest.getByRole('button', { name: 'Entrar na sala' }).click()
await tiles(guest).first().waitFor({ timeout: 40000 })
await guest.waitForTimeout(4000)
const seen = await probe(guest)
console.log('guest sees the host:', seen)
if (!(seen[0]?.live?.mean > 3)) throw new Error('guest canvas is black')
await shot(guest, 'guest-1')

// The host picks another surface on the same broadcast; the guest keeps seeing frames.
await host.getByRole('button', { name: 'Trocar fonte' }).click()
await host.waitForTimeout(4000)
if ((await room(roomId)).screens.length !== 1) throw new Error('switching the source changed the screen list')
const switched = await probe(guest)
console.log('guest after the switch:', switched)
if (!(switched[0]?.live?.mean > 3) || switched[0].state !== '') throw new Error('guest lost the picture on switch')

// A guest may share too, unless the host says otherwise.
await guest.getByRole('button', { name: 'Compartilhar minha tela' }).click()
await waitScreens(roomId, 2)
await host.waitForTimeout(5000)
if (await tiles(host).count() !== 2) throw new Error('host never got a second tile')
console.log('host sees both:', await probe(host))
await shot(host, 'host-2')
await shot(guest, 'guest-2')

// Closing the room to guests ends the guest's screen and keeps the host's.
await host.getByRole('button', { name: 'Todos podem compartilhar' }).click()
const closed = await waitScreens(roomId, 1)
if (closed.screens[0].nickname !== 'host') throw new Error('the wrong screen survived the switch')
await guest.waitForTimeout(3000)
if (await guest.getByRole('button', { name: 'Compartilhar minha tela' }).count() !== 0) {
  throw new Error('a closed room still offers the guest a share button')
}
console.log('guest after close:', await probe(guest))
await shot(guest, 'guest-3')

await host.getByRole('button', { name: 'Parar de compartilhar' }).click()
await waitScreens(roomId, 0)
await guest.waitForTimeout(1500)
console.log('guest after host stopped:', await probe(guest))
await shot(guest, 'guest-4')

await browser.close()
console.log('done')
