/**
 * Keeps public/matroska-subtitles.min.js in step with the installed package.
 *
 * The parser is served from public/ rather than imported with `?url`, because
 * subtitles.ts is reachable from both the page graph and the worker graph and
 * each one emitted its own copy of the same 147 kB file. Copying it on install
 * means a version bump cannot leave the served copy behind.
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'

// `npm ci` runs before the rest of the tree is copied in the Docker build, so
// public/ need not exist yet; the real one lands on top a layer later.
mkdirSync('public', { recursive: true })
copyFileSync('node_modules/matroska-subtitles/dist/matroska-subtitles.min.js', 'public/matroska-subtitles.min.js')

// The page asks for the bundle by version, because the edge caches that URL
// for hours and a new copy at the old address would never be fetched. The
// same reason makes a silent mismatch dangerous, so it is not allowed to be
// silent — subtitles.ts is only read when it is beside us, which it is not
// during the install layer of the Docker build.
const { version } = JSON.parse(readFileSync('node_modules/matroska-subtitles/package.json', 'utf8'))
let source
try {
  source = readFileSync('src/subtitles.ts', 'utf8')
} catch {
  process.exit(0)
}
if (!source.includes(`/matroska-subtitles.min.js?v=${version}`)) {
  console.error(`sync-parser: src/subtitles.ts does not ask for matroska-subtitles ${version}; update the ?v= in its parserBundleUrl.`)
  process.exit(1)
}
