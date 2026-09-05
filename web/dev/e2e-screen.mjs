// Screen share end to end: a host publishes a synthetic screen (canvas + oscillator) to the
// MoQ relay and a viewer must paint it, freeze it on stop, and pick it up again on restart.
// Run from a directory with playwright installed: BASE=https://juntos.lol node e2e-screen.mjs

import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8080'
const OUT = new URL('.', import.meta.url).pathname

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
    let i = 0
    setInterval(() => {
      ctx.fillStyle = `hsl(${(i * 7) % 360},80%,50%)`
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
const waitLive = async (id, want, ms = 30000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const r = await room(id)
    if ((r.screenLive === true) === want) return r
    await new Promise((f) => setTimeout(f, 500))
  }
  throw new Error(`screenLive never became ${want}`)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const wire = (page, tag) => {
  page.on('console', (m) => { const t = m.text(); if (/moq|relay|screen|error|warn|WebTransport|catalog/i.test(t)) console.log(`[${tag}]`, m.type(), t.slice(0, 300)) })
  page.on('pageerror', (e) => console.log(`[${tag}] pageerror`, e.message))
}

const hostCtx = await browser.newContext({ locale: 'pt-BR' })
await hostCtx.addInitScript(skipOverlays)
await hostCtx.addInitScript(fakeDisplay)
const host = await hostCtx.newPage(); wire(host, 'host')
await host.goto(BASE)
await host.getByRole('button', { name: 'Compartilhar sua tela' }).click()
await host.fill('#nickname', 'host')
await host.getByRole('button', { name: 'Criar sala' }).click()
await host.waitForURL(/\/room\//, { timeout: 20000 })
const roomId = host.url().split('/room/')[1].split(/[/?#]/)[0]
console.log('room', roomId)
await waitLive(roomId, true)
console.log('host live: yes')
await host.screenshot({ path: OUT + (process.env.TAG ?? '') + 'host-1.png' })

const viewerCtx = await browser.newContext({ locale: 'pt-BR' })
await viewerCtx.addInitScript(skipOverlays)
const viewer = await viewerCtx.newPage(); wire(viewer, 'viewer')
await viewer.goto(`${BASE}/room/${roomId}`)
await viewer.fill('#join-nickname', 'viewer')
await viewer.getByRole('button', { name: 'Entrar na sala' }).click()
const canvas = viewer.locator('.screen-surface canvas:not([hidden])')
await canvas.waitFor({ timeout: 40000 })
await viewer.waitForTimeout(3000)
const probe = async () => viewer.evaluate(() => {
  const c = document.querySelector('.screen-surface canvas')
  const hint = document.querySelector('.screen-overlay p')?.textContent ?? ''
  return { w: c?.width, h: c?.height, data: c?.toDataURL('image/png').length, hint, frozen: c?.className }
})
console.log('viewer after live:', await probe())
await viewer.screenshot({ path: OUT + (process.env.TAG ?? '') + 'viewer-1.png' })
await canvas.screenshot({ path: OUT + (process.env.TAG ?? '') + 'viewer-canvas-1.png' })

await host.getByRole('button', { name: 'Parar de compartilhar' }).click()
await waitLive(roomId, false)
await viewer.waitForTimeout(1500)
console.log('viewer after stop:', await probe())
await viewer.screenshot({ path: OUT + (process.env.TAG ?? '') + 'viewer-2.png' })

await host.getByRole('button', { name: 'Compartilhar minha tela' }).click()
await waitLive(roomId, true)
await viewer.waitForTimeout(6000)
console.log('viewer after restart:', await probe())
await viewer.screenshot({ path: OUT + (process.env.TAG ?? '') + 'viewer-3.png' })
await canvas.screenshot({ path: OUT + (process.env.TAG ?? '') + 'viewer-canvas-3.png' })
await host.screenshot({ path: OUT + (process.env.TAG ?? '') + 'host-3.png' })

await browser.close()
console.log('done')
