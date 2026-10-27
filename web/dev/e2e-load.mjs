// Load harness: N browsers with a fake camera and microphone join one room,
// talk in the chat and turn their cameras on, while each page's heap and CPU
// time are sampled through the DevTools protocol. Fails on page errors, on
// errors the server sends over the socket, or when the room does not count
// everyone in. Written against the protocol of the room-call spec; it runs
// for real once the call UI is merged.
//
// Server: PORT=8095 REDIS_URL=redis://127.0.0.1:6379/5 plus the native local
// stack (see the e2e-local memory) with the MoQ relay variables.
// N=12 DURATION=60 BASE=http://127.0.0.1:8095 PW=/tmp/pw/package.json node e2e-load.mjs
// SERVER_PID=<pid> also samples the server's RSS and CPU.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const { chromium } = createRequire(process.env.PW ?? '/private/tmp/ss-debug/package.json')('playwright')

const base = process.env.BASE ?? 'http://127.0.0.1:8095'
const clients = Number(process.env.N ?? 12)
const durationMs = Number(process.env.DURATION ?? 60) * 1000
const chatEveryMs = Number(process.env.CHAT_EVERY_MS ?? 4000)
const sampleEveryMs = 5000
const serverPid = process.env.SERVER_PID

const failures = []
const check = (name, ok, detail = '') => { console.log(ok ? 'OK  ' : 'FAIL', name, detail); if (!ok) failures.push(name) }

const created = await fetch(`${base}/api/rooms`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nickname: 'load-host', name: `carga ${clients}` }),
})
if (!created.ok) throw new Error(`create room: ${created.status} ${await created.text()}`)
const { id: roomId } = await created.json()
console.log('room', roomId)
const roomInfo = async () => (await fetch(`${base}/api/rooms/${roomId}`)).json()

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !process.env.HEADED,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
})

const errorsByClient = new Map()
const socketErrors = new Map()
const note = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)

async function join(index) {
  const who = `c${String(index).padStart(2, '0')}`
  const ctx = await browser.newContext({ locale: 'pt-BR', permissions: ['camera', 'microphone'] })
  await ctx.addInitScript(() => { try { localStorage.setItem('ss.onboarding.v1', '1'); localStorage.setItem('ss.onboarding.v2', '1'); localStorage.setItem('ss.codec-notice.v1', '1') } catch {} })
  const page = await ctx.newPage()
  page.on('pageerror', (error) => { note(errorsByClient, who); console.log(`[${who} pageerror]`, error.message.slice(0, 200)) })
  page.on('console', (message) => { if (message.type() === 'error') console.log(`[${who} console]`, message.text().slice(0, 160)) })
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string' || !payload.includes('"error"')) return
      try {
        const message = JSON.parse(payload)
        if (message.type === 'error') note(socketErrors, message.error ?? message.errCode ?? 'unknown')
      } catch {}
    })
  })
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Performance.enable')

  await page.goto(`${base}/room/${roomId}`)
  const nickname = page.locator('#join-nickname').or(page.getByRole('textbox', { name: /apelido|nickname/i })).first()
  await nickname.fill(who, { timeout: 30_000 })
  await page.getByRole('button', { name: /Entrar|Join/i }).first().click()

  // Camera and microphone controls of the call bar; the names follow the
  // spec's wording in both languages.
  let camera = false
  for (const name of [/Ligar câmera|Turn on camera/i, /Ligar microfone|Turn on microphone|Ativar microfone|Unmute/i]) {
    const button = page.getByRole('button', { name }).first()
    try {
      await button.click({ timeout: 15_000 })
      if (String(name).includes('mera')) camera = true
    } catch {
      console.log(`[${who}] no control matching ${name}`)
    }
  }
  return { who, page, cdp, camera }
}

const started = Date.now()
const members = []
// A few at a time, as people arrive, so the join path is measured under load
// instead of all at the same instant.
for (let index = 0; index < clients; index += 3) {
  const batch = []
  for (let offset = 0; offset < 3 && index + offset < clients; offset++) batch.push(join(index + offset))
  members.push(...await Promise.all(batch))
}
console.log(`joined ${members.length} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
check('every client turned its camera on', members.every((member) => member.camera), members.filter((member) => !member.camera).map((member) => member.who).join(' '))

async function metrics(member) {
  const { metrics: list } = await member.cdp.send('Performance.getMetrics')
  const value = (name) => list.find((metric) => metric.name === name)?.value ?? 0
  return { heap: value('JSHeapUsedSize'), task: value('TaskDuration'), at: Date.now() }
}

function serverSample() {
  if (!serverPid) return null
  try {
    const [rss, cpu] = execFileSync('ps', ['-o', 'rss=,%cpu=', '-p', serverPid], { encoding: 'utf8' }).trim().split(/\s+/)
    return { rssMb: Number(rss) / 1024, cpu: Number(cpu) }
  } catch {
    return null
  }
}

const first = await Promise.all(members.map(metrics))
let previous = first
let chatsSent = 0
let chatsFailed = 0
const chatter = setInterval(() => {
  const member = members[Math.floor(Math.random() * members.length)]
  const box = member.page.getByRole('textbox', { name: /mensagem|message/i }).first()
  chatsSent++
  box.fill(`oi de ${member.who} ${Date.now() % 10_000}`).then(() => box.press('Enter')).catch(() => { chatsFailed++ })
}, chatEveryMs)

const until = Date.now() + durationMs
while (Date.now() < until) {
  await new Promise((resolve) => setTimeout(resolve, sampleEveryMs))
  const now = await Promise.all(members.map(metrics))
  const heaps = now.map((sample) => sample.heap / 1048576)
  const cpus = now.map((sample, index) => 100 * (sample.task - previous[index].task) / ((sample.at - previous[index].at) / 1000))
  previous = now
  const server = serverSample()
  const info = await roomInfo()
  console.log(
    `t=${Math.round((Date.now() - started) / 1000)}s members=${info.memberCount}`
    + ` heap max ${Math.max(...heaps).toFixed(0)}MB avg ${(heaps.reduce((a, b) => a + b, 0) / heaps.length).toFixed(0)}MB`
    + ` cpu max ${Math.max(...cpus).toFixed(0)}% avg ${(cpus.reduce((a, b) => a + b, 0) / cpus.length).toFixed(0)}%`
    + (server ? ` server ${server.rssMb.toFixed(0)}MB ${server.cpu}%` : ''),
  )
}
clearInterval(chatter)

const last = await Promise.all(members.map(metrics))
const growth = last.map((sample, index) => (sample.heap - first[index].heap) / 1048576)
console.log('heap growth per client (MB):', growth.map((value) => value.toFixed(1)).join(' '))
const info = await roomInfo()
check('the room counts every client', info.memberCount === clients, `memberCount=${info.memberCount}`)
check('every chat message went out', chatsSent > 0 && chatsFailed === 0, `${chatsSent - chatsFailed}/${chatsSent}`)
check('no page errors', errorsByClient.size === 0, JSON.stringify(Object.fromEntries(errorsByClient)))
check('the server sent no errors over the socket', socketErrors.size === 0, JSON.stringify(Object.fromEntries(socketErrors)))

await browser.close()
console.log(failures.length ? `failed: ${failures.join(', ')}` : 'done')
process.exitCode = failures.length ? 1 : 0
