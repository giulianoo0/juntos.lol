// Mouth-to-ear voice latency over the real MoQ relay. One tab publishes a fake microphone
// (a click track, through the call's echo cancellation / noise suppression / AGC) and the
// other subscribes; each stamps every click on the wall clock, at the capture and at the
// speakers' graph plus the output device latency. Spawns its own Vite for dev/call-latency.html.
//
//   ENV_FILE=../.env (or MOQ_RELAY_URL, MOQ_PUBLISH_TOKEN, MOQ_SUBSCRIBE_TOKEN) PW=<dir with playwright> \
//     node dev/e2e-call-latency.mjs [--latency real-time|ms] [--max ms] [--seconds 30]

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.resolve(here, '..')
const args = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const latency = opt('--latency', 'real-time')
const max = opt('--max', '')
const seconds = Number(opt('--seconds', '30'))
// ENV_FILE names a dotenv file to read the relay settings from (the repo's .env).
if (process.env.ENV_FILE) {
  for (const line of readFileSync(process.env.ENV_FILE, 'utf8').split('\n')) {
    const m = /^(MOQ_[A-Z_]+)=(.*)$/.exec(line.trim())
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}
const { MOQ_RELAY_URL: relayUrl, MOQ_PUBLISH_TOKEN: pubToken, MOQ_SUBSCRIBE_TOKEN: subToken } = process.env
if (!relayUrl || !pubToken || !subToken) { console.error('MOQ_RELAY_URL, MOQ_PUBLISH_TOKEN and MOQ_SUBSCRIBE_TOKEN are required'); process.exit(2) }
const require = createRequire(path.join(process.env.PW ?? web, 'package.json'))
const { chromium } = require('playwright')

// A 1 kHz burst of 40 ms every 1.5 s: short enough to time, voiced enough to pass noise suppression.
const RATE = 48000
const PERIOD = 1.5
const samples = new Int16Array(RATE * PERIOD * 4)
for (let k = 0; k < 4; k++) {
  const start = Math.round(k * PERIOD * RATE)
  for (let i = 0; i < RATE * 0.04; i++) samples[start + i] = Math.round(Math.sin(2 * Math.PI * 1000 * i / RATE) * 0.8 * 32767)
}
const wav = Buffer.alloc(44 + samples.byteLength)
wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples.byteLength, 4); wav.write('WAVE', 8)
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
wav.write('data', 36); wav.writeUInt32LE(samples.byteLength, 40)
Buffer.from(samples.buffer).copy(wav, 44)
const wavPath = path.join(mkdtempSync(path.join(tmpdir(), 'call-latency-')), 'clicks.wav')
writeFileSync(wavPath, wav)

const port = 5191
const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { cwd: web, stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve) => vite.stdout.on('data', (d) => { if (String(d).includes('Local')) resolve() }))

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`],
})
const broadcast = `juntos/latency-${Date.now()}/rig/av/me.hang`
const page = async (role, token) => {
  const p = await (await browser.newContext()).newPage()
  p.on('pageerror', (e) => console.log(`[${role}] pageerror`, e.message))
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${role}]`, m.text().slice(0, 200)) })
  const q = new URLSearchParams({ role, relay: `${relayUrl}/${token}`, path: broadcast, latency, ...(max ? { max } : {}) })
  await p.goto(`http://localhost:${port}/dev/call-latency.html?${q}`)
  await p.waitForFunction(() => window.info?.ready === true, null, { timeout: 30000 })
    .catch(async (e) => { console.log(`[${role}] never ready`, JSON.stringify(await p.evaluate(() => window.info))); throw e })
  return p
}

try {
  const talk = await page('talk', pubToken)
  // The relay announces nothing: a subscriber that beats the catalog finds no track, so give it a moment.
  await talk.waitForTimeout(2000)
  const listen = await page('listen', subToken)
  await listen.waitForTimeout(seconds * 1000)
  const mouth = await talk.evaluate(() => window.stamps)
  const ear = await listen.evaluate(() => window.stamps)
  const listenInfo = await listen.evaluate(() => window.info)
  const talkInfo = await talk.evaluate(() => window.info)
  // Each ear click belongs to the latest mouth click before it, if that one is under a period away.
  const delays = []
  for (const at of ear) {
    const source = mouth.filter((m) => m <= at).at(-1)
    if (source !== undefined && at - source < PERIOD * 1000) delays.push(at - source)
  }
  delays.sort((a, b) => a - b)
  const pick = (q) => delays[Math.min(delays.length - 1, Math.floor(q * delays.length))]
  console.log(JSON.stringify({ latency, max, talk: talkInfo, listen: listenInfo, mouthClicks: mouth.length, earClicks: ear.length, matched: delays.length }))
  if (delays.length) console.log(`mouth-to-ear ms: min ${delays[0].toFixed(0)} p50 ${pick(0.5).toFixed(0)} p90 ${pick(0.9).toFixed(0)} max ${delays.at(-1).toFixed(0)}`)
} finally {
  await browser.close()
  vite.kill()
}
