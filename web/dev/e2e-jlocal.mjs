// Screen share through the jlocal companion, end to end: the host picks a display in the
// companion's picker, a guest must see frames arrive; the host then switches to a window
// without leaving the relay, and the guest must keep seeing frames. Needs jlocal running on
// this machine with the site's origin allowed, and Screen Recording granted to it.
// Run from a directory with playwright installed: BASE=http://127.0.0.1:8080 node e2e-jlocal.mjs

import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8080'
const OUT = new URL('.', import.meta.url).pathname
const shot = (page, name) => page.screenshot({ path: OUT + (process.env.TAG ?? '') + name + '.png' })

const skipOverlays = () => {
  try { localStorage.setItem('ss.onboarding.v1', '1') } catch {}
  try { localStorage.setItem('ss.codec-notice.v1', '1') } catch {}
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
  page.on('console', (m) => { const t = m.text(); if (/moq|relay|screen|error|warn|WebTransport|catalog|rendition|jlocal/i.test(t)) console.log(`[${tag}]`, m.type(), t.slice(0, 300)) })
  page.on('pageerror', (e) => console.log(`[${tag}] pageerror`, e.message))
}
const newPage = async (tag) => {
  const context = await browser.newContext({ locale: 'pt-BR' })
  await context.addInitScript(skipOverlays)
  const page = await context.newPage()
  wire(page, tag)
  return page
}

/** The remote canvas as the guest paints it: size and how much picture it holds. */
const probe = async (page) => page.evaluate(() => [...document.querySelectorAll('.screen-tile')].map((tile) => {
  const canvas = tile.querySelector('canvas')
  let mean = null
  if (canvas) {
    // Mean luminance of a downscale: a decoded picture is well above black.
    const small = document.createElement('canvas'); small.width = 64; small.height = 36
    const ctx = small.getContext('2d'); ctx.drawImage(canvas, 0, 0, 64, 36)
    const px = ctx.getImageData(0, 0, 64, 36).data
    let sum = 0
    for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3
    mean = Math.round(sum / (px.length / 4))
  }
  return {
    label: tile.querySelector('.screen-tile-label')?.textContent ?? '',
    state: tile.querySelector('.screen-tile-state')?.textContent ?? '',
    canvas: canvas ? { w: canvas.width, h: canvas.height, bytes: canvas.toDataURL('image/png').length, mean } : null,
  }
}))
const waitLive = async (page, ms = 30000) => {
  const until = Date.now() + ms
  let last = null
  while (Date.now() < until) {
    last = await probe(page)
    const tile = last.find((t) => !t.label.includes('você'))
    // A painted 1080p canvas is far above a blank one's few hundred PNG bytes.
    if (tile && tile.state === '' && tile.canvas && tile.canvas.bytes > 5000 && tile.canvas.mean > 3) return tile
    await page.waitForTimeout(500)
  }
  throw new Error(`guest never saw frames (last: ${JSON.stringify(last)})`)
}

const host = await newPage('host')
await host.goto(BASE)
await host.waitForFunction(() => document.body.textContent.includes('jlocal conectado'), null, { timeout: 15000 })
console.log('jlocal connected on the host page')
await host.getByRole('button', { name: 'Compartilhar sua tela' }).click()
// The home page opens the companion's picker straight away.
await host.getByRole('radio').first().waitFor({ timeout: 15000 })
await host.getByRole('button', { name: 'Compartilhar', exact: true }).click()
await host.fill('#nickname', 'host')
await host.getByRole('button', { name: 'Criar sala' }).click()
await host.waitForURL(/\/room\//, { timeout: 20000 })
const roomId = host.url().split('/room/')[1].split(/[/?#]/)[0]
console.log('room', roomId)
await waitScreens(roomId, 1)
console.log('host live: yes')
await shot(host, 'jhost-1')

const guest = await newPage('guest')
await guest.goto(`${BASE}/room/${roomId}`)
await guest.fill('#join-nickname', 'guest')
await guest.getByRole('button', { name: 'Entrar na sala' }).click()
const first = await waitLive(guest)
console.log('guest sees the display:', first)
await shot(guest, 'jguest-1')
await (async () => { const data = await guest.evaluate(() => document.querySelector('.screen-tile canvas')?.toDataURL('image/png') ?? ''); (await import('node:fs')).writeFileSync(OUT + 'jguest-canvas-before.png', Buffer.from(data.split(',')[1] ?? '', 'base64')) })()

// Switching to a window keeps the same broadcast; the guest must keep painting.
await host.getByRole('button', { name: 'Trocar fonte' }).click()
await host.getByRole('tab', { name: 'Janelas' }).click()
// The displays stay on screen while the windows load; wait for a window card, not just any card.
await host.getByRole('radio').filter({ hasText: /kitty|Discord|Finder|Chrome|Spotify/ }).first().waitFor({ timeout: 15000 })
// A real app's window, not the cursor or the menu bar the window server also lists.
const cards = host.getByRole('radio')
const texts = await cards.allTextContents()
const area = (text) => { const m = /(\d+)×(\d+)/.exec(text); return m ? Number(m[1]) * Number(m[2]) : 0 }
const ranked = texts.map((text, index) => ({ text, index, area: area(text) })).filter((c) => !/Window Server/.test(c.text)).sort((a, b) => b.area - a.area)
// An app whose window looks nothing like a browser, so the switch is unmistakable in the dump.
const biggest = ranked.find((c) => /kitty|Discord|Spotify/.test(c.text) && c.area > 200_000) ?? ranked[0]
await cards.nth(biggest.index).click()
console.log('switching to:', biggest.text.trim())
await host.getByRole('button', { name: 'Trocar', exact: true }).click()
await host.waitForTimeout(4000)
const after = await room(roomId)
if ((after.screens ?? []).length !== 1) throw new Error(`switch changed the screen list: ${JSON.stringify(after.screens)}`)
const before = first.canvas.bytes
let moved = null
for (let i = 0; i < 20 && !moved; i += 1) {
  const now = await waitLive(guest, 10000)
  if (now.canvas.w !== first.canvas.w || now.canvas.h !== first.canvas.h || Math.abs(now.canvas.bytes - before) > 2000) moved = now
  else await guest.waitForTimeout(500)
}
if (!moved) throw new Error('guest never saw the switched surface')
console.log('guest sees the window:', moved)
// The canvas itself, as decoded, since a headless screenshot may not composite it.
const dump = async (page, name) => { const data = await page.evaluate(() => document.querySelector('.screen-tile canvas')?.toDataURL('image/png') ?? ''); await import('node:fs').then((fs) => fs.writeFileSync(OUT + name + '.png', Buffer.from(data.split(',')[1] ?? '', 'base64'))) }
await dump(guest, 'jguest-canvas-after')
await shot(guest, 'jguest-2')
await shot(host, 'jhost-2')

// The sounds menu lists the apps the mix can leave out.
await host.getByRole('button', { name: 'Sons da transmissão' }).click()
await host.getByRole('menuitemcheckbox').nth(1).waitFor({ timeout: 10000 })
console.log('sound menu rows:', await host.getByRole('menuitemcheckbox').count())
await shot(host, 'jhost-3')
await host.keyboard.press('Escape')

await host.getByRole('button', { name: 'Parar de compartilhar' }).click()
await waitScreens(roomId, 0)
await browser.close()
console.log('done')
