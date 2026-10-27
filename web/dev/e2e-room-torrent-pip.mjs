// Sala nova de ponta a ponta: cria, entra, abre um torrent pelo Compartilhar,
// liga uma legenda ASS, abre o PiP e confere que um convidado assiste.
// PW=<package.json com playwright> BASE=http://127.0.0.1:8090 SHOTS=<dir> node web/dev/e2e-room-torrent-pip.mjs
import { createRequire } from 'node:module'

const { chromium } = createRequire(process.env.PW)('playwright')
const base = process.env.BASE ?? 'http://127.0.0.1:8090'
const shots = process.env.SHOTS ?? '.'
const magnet = process.env.MAGNET ?? 'magnet:?xt=urn:btih:1b18ad819975895766adfccf930c2b2facb0a48a'

const browser = await chromium.launch({ channel: 'chrome', headless: !process.env.HEADED, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })

async function person(name) {
  const context = await browser.newContext({ locale: 'pt-BR', ignoreHTTPSErrors: true, viewport: { width: 1360, height: 860 } })
  await context.addInitScript(() => {
    try {
      localStorage.setItem('ss.onboarding.v1', '1')
      localStorage.setItem('ss.codec-notice.v1', '1')
    } catch {}
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.log(`[${name} pageerror]`, error.message))
  page.on('console', (message) => { if (message.type() === 'error') console.log(`[${name} console]`, message.text().slice(0, 200)) })
  return page
}

const password = process.env.PASSWORD ?? ''

async function enter(page, nickname, withPassword = false) {
  const field = page.getByRole('textbox').first()
  await field.waitFor({ timeout: 30_000 })
  await field.fill(nickname)
  if (withPassword) await page.locator('input[type=password]').fill(password)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
}

const playing = (page) => page.waitForFunction(() => {
  const video = document.querySelector('video.video')
  return video && video.readyState >= 2 && video.currentTime > 0.5
}, null, { timeout: 300_000, polling: 500 })

const host = await person('host')
await host.goto(base)
await host.getByRole('button', { name: 'Criar sala' }).click()
await host.getByRole('textbox', { name: 'Nome da sala' }).fill('E2E torrent')
if (password) {
  await host.getByRole('button', { name: /senha/i }).first().click()
  await host.getByPlaceholder('Senha').fill(password)
}
await host.getByRole('button', { name: /sem conta|Criar$/ }).click()
await host.waitForURL(/\/room\//, { timeout: 30_000 })
const roomUrl = host.url().split('#')[0]
console.log('sala', roomUrl)
await enter(host, 'host')

await host.getByRole('button', { name: 'Compartilhar' }).click()
await host.getByRole('menuitem', { name: 'Torrent' }).click()
await host.getByPlaceholder('magnet:?xt=urn:btih:…').fill(magnet)
await host.getByRole('button', { name: 'Buscar arquivos' }).click()
const file = host.getByRole('button', { name: /\.(mkv|mp4)/ }).first()
await file.waitFor({ timeout: 180_000 })
console.log('arquivo', await file.innerText())
await file.click()

await host.locator('video.video').waitFor({ timeout: 300_000 })
await host.evaluate(() => void document.querySelector('video.video')?.play().catch(() => {}))
await playing(host)
console.log('host tocando')
await host.screenshot({ path: `${shots}/torrent-host.png` })

const guest = await person('convidado')
await guest.goto(roomUrl)
if (password) {
  const outsider = await fetch(`${base}/api/rooms/${roomUrl.split('/').pop()}`)
  console.log('sala trancada para quem está de fora:', outsider.status)
}
await enter(guest, 'convidado', Boolean(password))
await guest.locator('video.video').waitFor({ timeout: 120_000 })
await guest.evaluate(() => void document.querySelector('video.video')?.play().catch(() => {}))
await playing(guest)
const drift = await Promise.all([host, guest].map((page) => page.evaluate(() => document.querySelector('video.video').currentTime)))
console.log('convidado tocando; host x convidado (s):', drift.map((value) => value.toFixed(2)).join(' x '))
await guest.screenshot({ path: `${shots}/torrent-guest.png` })

await host.getByRole('button', { name: /Configurações/i }).click({ force: true })
await host.getByRole('radio', { name: 'Legendas' }).click()
const rows = host.getByTestId('setting-subtitles').locator('button[aria-pressed]')
const labels = await rows.allInnerTexts()
console.log('legendas', labels.length, labels.slice(0, 4).join(' | ').replace(/\n/g, ' '))
const track = labels.findIndex((label) => !/Desligad|Off/i.test(label))
await rows.nth(track >= 0 ? track : Math.min(1, labels.length - 1)).click()
await host.keyboard.press('Escape')
await host.locator('canvas.ass-layer, .subtitle-layer, .player-subtitles').first().waitFor({ state: 'attached', timeout: 60_000 }).catch(() => console.log('camada de legenda não apareceu na página'))

console.log('documentPictureInPicture:', await host.evaluate(() => 'documentPictureInPicture' in window))
await host.getByRole('button', { name: 'Picture-in-picture' }).click({ force: true })
await host.waitForTimeout(2500)
const pip = await host.evaluate(() => {
  const doc = window.documentPictureInPicture?.window?.document
  if (doc) {
    return {
      mode: 'document',
      video: Boolean(doc.querySelector('video')),
      subtitles: Boolean(doc.querySelector('canvas.ass-layer, .subtitle-layer, .player-subtitles')),
      size: [window.documentPictureInPicture.window.innerWidth, window.documentPictureInPicture.window.innerHeight],
    }
  }
  return { mode: document.pictureInPictureElement ? 'element' : 'none' }
})
console.log('pip', JSON.stringify(pip))
await host.screenshot({ path: `${shots}/torrent-pip-host.png` })

await browser.close()
if (pip.mode === 'none') {
  console.log('FALHOU: PiP não abriu')
  process.exit(1)
}
console.log('OK')
