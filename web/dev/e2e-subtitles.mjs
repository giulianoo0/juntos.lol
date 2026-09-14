// Host imports a subtitle for the room, a guest imports one for itself, and
// the guest copies the host's delay. Needs the native local stack (see the
// e2e-local memory) and PW pointing at a playwright install.
import { createRequire } from 'node:module'
import path from 'node:path'
const { chromium } = createRequire(process.env.PW ?? '/private/tmp/ss-debug/package.json')('playwright')
const base = process.env.BASE ?? 'http://127.0.0.1:8090'
const video = process.env.VIDEO
const hostSrt = process.env.HOST_SRT
const guestSrt = process.env.GUEST_SRT
if (!video || !hostSrt || !guestSrt) throw new Error('VIDEO, HOST_SRT and GUEST_SRT are required')

const browser = await chromium.launch({ channel: 'chrome', args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'] })
const context = async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR' })
  await ctx.addInitScript(() => { try { localStorage.setItem('ss.onboarding.v1', '1'); localStorage.setItem('ss.codec-notice.v1', '1') } catch {} })
  return ctx
}
const wire = (page, who) => {
  page.on('console', (m) => { if (m.type() === 'error' || /subtitle|legenda/i.test(m.text())) console.log(`[${who} console]`, m.text().slice(0, 200)) })
  page.on('response', (r) => { if (r.status() >= 400 && !/manifest|\.m3u8/.test(r.url())) console.log(`[${who} http]`, r.status(), r.url().slice(0, 120)) })
  page.on('pageerror', (e) => console.log(`[${who} pageerror]`, e.message))
}
const check = (name, ok) => { console.log(ok ? 'OK  ' : 'FAIL', name); if (!ok) process.exitCode = 1 }

const host = await (await context()).newPage(); wire(host, 'host')
await host.goto(base)
await host.locator('input[type=file][accept="video/*,.mkv"]').setInputFiles(video)
await host.locator('#nickname').fill('host')
await host.getByRole('button', { name: /Criar sala|Create room/i }).click()
await host.waitForURL(/\/room\//, { timeout: 60_000 })
const roomID = host.url().split('/room/')[1].split(/[?#]/)[0]
const info = async () => (await fetch(`${base}/api/rooms/${roomID}`)).json()
const until = async (name, pred, ms = 120_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const i = await info(); if (pred(i)) return i; await new Promise((r) => setTimeout(r, 1000)) }; throw new Error('timeout: ' + name) }
let i = await until('ready', (i) => i.status === 'ready', 180_000)
console.log('room ready', roomID, 'base', i.mediaBaseUrl)

const gear = (page) => page.getByRole('button', { name: /Configurações|Settings/i })
const openGroup = async (page, name) => { await gear(page).click(); await page.getByRole('button', { name }).click() }
const importFile = async (page, file) => page.locator('input[type=file][accept=".srt,.ass,.ssa,.vtt,.sub"]').setInputFiles(file)
const groupText = (page, id) => page.getByTestId(`setting-${id}`).innerText()

// The gear shows before any track exists, with the import as the first row.
await openGroup(host, /^Legendas/)
const rows = await host.getByTestId('setting-subtitles').getByRole('button').allInnerTexts()
check('import is the first subtitle row: ' + JSON.stringify(rows), rows[1]?.includes('Importar arquivo'))
await host.keyboard.press('Escape')
await host.mouse.click(5, 5)

// Host import lands in the room for everyone.
await importFile(host, hostSrt)
i = await until('imported track in room', (i) => (i.subtitleTracks ?? []).some((t) => t.index === 1000), 30_000)
const imported = i.subtitleTracks.find((t) => t.index === 1000)
check('room track named after the file: ' + JSON.stringify(imported), imported.title === path.basename(hostSrt))
const vttUrl = `${i.mediaBaseUrl}/subs/sub_1000_${imported.language}.vtt`
const vtt = await (await fetch(vttUrl)).text()
check('vtt published to the bucket: ' + vttUrl, vtt.startsWith('WEBVTT') && vtt.includes('Oi do host'))
await host.waitForTimeout(1500)
await gear(host).click()
check('host menu shows the imported track picked', (await groupText(host, 'subtitles')).includes(path.basename(hostSrt)))
await host.mouse.click(5, 5)

// Host sets a delay of +0.50 s with two clicks.
await openGroup(host, /Atraso da legenda/)
await host.getByRole('button', { name: 'Mais atraso' }).click()
await host.getByRole('button', { name: 'Mais atraso' }).click()
check('host delay reads +0,50 s', (await groupText(host, 'subtitleDelay')).includes('+0,50 s'))
// Typing an exact value.
await host.getByTestId('delay-control').locator('.delay-value').click()
await host.getByRole('textbox', { name: 'Atraso da legenda' }).fill('-1,25')
await host.keyboard.press('Enter')
check('host typed delay reads -1,25 s', (await groupText(host, 'subtitleDelay')).includes('-1,25 s'))
await host.mouse.click(5, 5)
const hostCues = await host.evaluate(() => Array.from(document.querySelector('video').textTracks).map((t) => Array.from(t.cues ?? []).map((c) => c.startTime)))
check('host cues moved by the delay (1.0 -> -0.25): ' + JSON.stringify(hostCues), hostCues.some((cues) => cues.includes(-0.25)))

// Guest sees the room track, keeps its own import to itself, copies the host.
const guest = await (await context()).newPage(); wire(guest, 'guest')
await guest.goto(`${base}/room/${roomID}`)
await guest.fill('#join-nickname', 'guest')
await guest.getByRole('button', { name: 'Entrar na sala' }).click()
await guest.waitForSelector('video', { timeout: 60_000 })
await guest.waitForTimeout(2000)
await openGroup(guest, /^Legendas/)
check('guest sees the host import', await guest.getByRole('button', { name: path.basename(hostSrt) }).isVisible())
await guest.mouse.click(5, 5)
await importFile(guest, guestSrt)
await guest.waitForTimeout(1000)
await gear(guest).click()
check('guest menu shows its own file picked', (await groupText(guest, 'subtitles')).includes(path.basename(guestSrt)))
await guest.mouse.click(5, 5)
i = await info()
check('guest import stayed out of the room', (i.subtitleTracks ?? []).filter((t) => t.index >= 1000).length === 1)
const guestTracks = await guest.evaluate(() => Array.from(document.querySelectorAll('track')).map((t) => t.getAttribute('src')))
check('guest track is a blob: ' + JSON.stringify(guestTracks), guestTracks.some((src) => src.startsWith('blob:')))

await openGroup(guest, /Atraso da legenda/)
await guest.getByRole('button', { name: 'Copiar do host' }).click()
check('guest delay copied from host', (await groupText(guest, 'subtitleDelay')).includes('-1,25 s'))
check('guest track copied from host', (await groupText(guest, 'subtitles')).includes(path.basename(hostSrt)))
await guest.screenshot({ path: process.env.SHOT ?? 'e2e-subtitles.png' })
await host.getByRole('button', { name: 'Copiar do host' }).count().then((n) => check('host has no copy-from-host row', n === 0))
await browser.close()
