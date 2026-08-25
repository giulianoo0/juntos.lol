#!/usr/bin/env node
// Drives dev/measure.html across a set of injected RTTs and prints a table.
// Needs: a running `vite` dev server (VITE_URL, default http://localhost:5173),
// `go build ./cmd/rangefixture` done at the repo root, and playwright resolvable (PLAYWRIGHT_DIR points at a
// node_modules that has it, e.g. the e2e scratchpad).
//
//   FILE=/path/to/movie.mkv node dev/measure.mjs [--rtt 20,50,100,200] [--seconds 60] [--audio]
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const args = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const rtts = opt('--rtt', '20,50,100,200').split(',').map(Number)
const seconds = Number(opt('--seconds', '60'))
const audio = args.includes('--audio') ? '1' : '0'
const cache = opt('--cache', '96')
const file = process.env.FILE
if (!file) { console.error('FILE is required'); process.exit(2) }
const viteUrl = process.env.VITE_URL ?? 'http://localhost:5173'
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR ?? repo, 'package.json'))
const { chromium } = require('playwright')

const fixtureAddr = '127.0.0.1:8099'
function startFixture(rtt) {
  const child = spawn(path.join(repo, 'rangefixture'), [], {
    cwd: repo,
    env: { ...process.env, FILE: file, ADDR: fixtureAddr, TLS: '1', RTT_MS: String(rtt), JITTER_MS: String(Math.round(rtt / 10)), CAP_BYTES: String(16 * 2 ** 20) },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => { process.stderr.write(d); if (String(d).includes('rangefixture:')) resolve(child) })
    child.on('exit', (code) => reject(new Error(`fixture exited ${code}`)))
  })
}

const browser = await chromium.launch({ channel: 'chrome', args: ['--ignore-certificate-errors'] })
const rows = []
for (const rtt of rtts) {
  const fixture = await startFixture(rtt)
  const page = await browser.newPage({ ignoreHTTPSErrors: true })
  const url = `${viteUrl}/dev/measure.html?base=https://${fixtureAddr}/f&seconds=${seconds}&audio=${audio}&cache=${cache}`
  await page.goto(url)
  await page.waitForFunction(() => window.__measure?.done, null, { timeout: (seconds + 120) * 1000 })
  const m = await page.evaluate(() => window.__measure)
  rows.push({ rtt, ...m })
  console.error(`rtt=${rtt}ms → ${m.error ?? `${m.sustainedMbitPerSecond} Mbit/s sustained, ${m.realtimeRatio}× realtime, first segment ${m.firstSegmentMs} ms, ${m.requests} requests`}`)
  await page.close()
  fixture.kill()
}
await browser.close()
console.log('\n| RTT ms | sustained Mbit/s | avg Mbit/s | × realtime | first segment ms | requests | error |')
console.log('|---|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.rtt} | ${r.sustainedMbitPerSecond} | ${r.mbitPerSecond} | ${r.realtimeRatio} | ${r.firstSegmentMs} | ${r.requests} | ${r.error ?? ''} |`)
