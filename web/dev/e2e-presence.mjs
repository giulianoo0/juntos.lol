// Who is in the room, end to end on the real room page: a second tab of the same browser
// takes the first one's seat (the old tab says so), closing a tab takes the person out in
// seconds, a reload walks back into the same seat, and the host's kick takes someone out at once.
//
//   BASE=http://127.0.0.1:8090 PW=<dir with playwright> node dev/e2e-presence.mjs

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE ?? 'http://127.0.0.1:8090'
const require = createRequire(path.join(process.env.PW ?? path.resolve(here, '..'), 'package.json'))
const { chromium } = require('playwright')

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const until = async (what, check, ms = 15000) => {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    last = await check()
    if (last) return last
    await new Promise((f) => setTimeout(f, 200))
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`)
}
const browserContext = async () => {
  const context = await browser.newContext({ locale: 'pt-BR', viewport: { width: 1280, height: 800 } })
  await context.addInitScript(() => {
    try {
      localStorage.setItem('ss.onboarding.v2', '1')
      localStorage.setItem('ss.codec-notice.v1', 'dismissed')
    } catch { /* first paint only */ }
  })
  return context
}
const enter = async (context, tag, roomId, nickname, hash = '') => {
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log(`[${tag}] pageerror`, e.message))
  await page.goto(`${BASE}/room/${roomId}${hash}`)
  const name = page.getByLabel('Seu nome')
  await name.waitFor({ timeout: 8000 })
  await name.fill(nickname)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  return page
}
// The names in the host's people list, one per seat.
const people = (page) => page.evaluate(() => [...new Set([...document.querySelectorAll('[data-member]')].map((el) => el.getAttribute('data-member')))])

try {
  const created = await (await fetch(`${BASE}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'host', kind: 'screen' }),
  })).json()
  const hostContext = await browserContext()
  const host = await enter(hostContext, 'host', created.id, 'host', `#owner=${created.ownerToken}`)
  await until('the host in the room', async () => (await people(host)).length === 1)

  const guestBrowser = await browserContext()
  const firstTab = await enter(guestBrowser, 'tab1', created.id, 'guest')
  await until('the guest in the room', async () => (await people(host)).length === 2)
  const seat = (await people(host)).sort()
  console.log('seats', seat)

  const secondTab = await enter(guestBrowser, 'tab2', created.id, 'guest')
  await until('the old tab telling it was replaced', () => firstTab.getByText('A sala está aberta em outra aba').isVisible())
  await new Promise((f) => setTimeout(f, 1500))
  const after = (await people(host)).sort()
  if (JSON.stringify(after) !== JSON.stringify(seat)) throw new Error(`second tab changed the seats: ${after}`)
  console.log('second tab took the seat: yes')
  await firstTab.screenshot({ path: path.join(here, 'presence-replaced.png') })

  await secondTab.reload()
  await until('the reloaded tab back in the room', async () => (await secondTab.locator('[data-member]').count()) > 0)
  if (await secondTab.getByLabel('Seu nome').isVisible()) throw new Error('the reload stopped at the door')
  await new Promise((f) => setTimeout(f, 1500))
  const reloaded = (await people(host)).sort()
  if (JSON.stringify(reloaded) !== JSON.stringify(seat)) throw new Error(`the reload changed the seats: ${reloaded}`)
  console.log('reload walked back in, same seat: yes')

  const closedAt = Date.now()
  await secondTab.close()
  await until('the closed tab leaving the room', async () => (await people(host)).length === 1, 15000)
  console.log(`closed tab gone in ${Date.now() - closedAt} ms`)

  const kickedContext = await browserContext()
  const kicked = await enter(kickedContext, 'kicked', created.id, 'kicked')
  await until('the third guest in the room', async () => (await people(host)).length === 2)
  const target = (await people(host)).find((id) => !seat.includes(id))
  await host.evaluate(() => { window.__kickAt = performance.now() })
  await kickedContext.setOffline(true)
  const tile = host.locator(`[data-member="${target}"]`).first()
  await tile.click({ button: 'right' })
  await host.getByRole('menuitem', { name: 'Expulsar' }).click()
  const kickAt = Date.now()
  await until('the kicked guest gone from the host', async () => (await people(host)).length === 1, 5000)
  console.log(`kick of an offline guest took ${Date.now() - kickAt} ms`)
  console.log('OK')
} finally {
  await browser.close()
}
