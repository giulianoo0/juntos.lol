/**
 * Keeps public/matroska-subtitles.min.js in step with the installed package,
 * so a version bump cannot leave the served copy behind.
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'

mkdirSync('public', { recursive: true })
copyFileSync('node_modules/matroska-subtitles/dist/matroska-subtitles.min.js', 'public/matroska-subtitles.min.js')

// The page asks for the bundle by version, so a mismatch would serve a stale
// copy from the edge for hours. subtitles.ts is only read when it is beside
// us, which it is not during the install layer of the Docker build.
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
