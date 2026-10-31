// Renders every mascot with every accessory into the Android app's drawables
// (android/design/src/main/res/drawable-nodpi/mascot_<kind>[_<accessory>].png) from avatares.html.
// With the dev server up (npx vite --port 5399) and PW pointing at a playwright install:
//   PW=<dir>/package.json node web/dev/mascots-android.mjs   (BASE=http://localhost:5399 by default)
// then turn the PNGs into lossless WebP: for f in mascot_*.png; do cwebp -quiet -lossless -z 6"$f" -o "${f%.png}.webp" && rm "$f"; done
import { createRequire } from 'node:module'

const { chromium } = createRequire(process.env.PW ?? '/private/tmp/ss-debug/package.json')('playwright')

const BASE = process.env.BASE ?? 'http://localhost:5399'
const OUT = process.env.OUT ?? new URL('../../android/design/src/main/res/drawable-nodpi/', import.meta.url).pathname
const PIXELS = 384
const TILE = 132

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: PIXELS / TILE, reducedMotion: 'reduce' })
await page.goto(`${BASE}/dev/avatares.html?still=1`, { waitUntil: 'networkidle' })
const accessories = await page.evaluate(() => [...document.querySelectorAll('.bar .group')[1].querySelectorAll('button')].map((b) => b.textContent))
const ids = await page.evaluate(async () => (await import('/src/mascot/types.ts')).MASCOT_ACCESSORIES.map((a) => a.id))
if (ids.length !== accessories.length) throw new Error('accessory buttons and ids disagree')

for (const accessory of ids) {
  await page.goto(`${BASE}/dev/avatares.html?still=1&acc=${accessory}`, { waitUntil: 'networkidle' })
  await page.addStyleTag({ content: 'html, body, main, .tile { background: transparent !important; border-color: transparent !important }' })
  await page.waitForTimeout(300)
  for (const tile of await page.locator('.tile[data-kind]').all()) {
    const kind = await tile.getAttribute('data-kind')
    const suffix = accessory === 'none' ? '' : `_${accessory.replaceAll('-', '_')}`
    const svg = tile.locator('svg').first()
    await svg.scrollIntoViewIfNeeded()
    const box = await svg.boundingBox()
    // The element's own box rounds to 133 px tall at this scale; the art is a square.
    await page.screenshot({ path: `${OUT}mascot_${kind}${suffix}.png`, omitBackground: true, clip: { x: box.x, y: box.y, width: TILE, height: TILE } })
  }
}
await browser.close()
console.log(OUT)
