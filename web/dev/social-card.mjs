// Renders the link preview (public/social-card.png) from social-card.html.
// With the dev server up (npx vite --port 5399), from a directory with playwright installed:
//   node web/dev/social-card.mjs   (BASE=http://localhost:5399 by default)
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:5399'
const OUT = process.env.OUT ?? new URL('../public/social-card.png', import.meta.url).pathname

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
await page.goto(`${BASE}/dev/social-card.html`, { waitUntil: 'networkidle' })
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(300)
await page.locator('#card').screenshot({ path: OUT })
await browser.close()
console.log(OUT)
