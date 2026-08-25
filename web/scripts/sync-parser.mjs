/**
 * Keeps public/matroska-subtitles.min.js in step with the installed package.
 *
 * The parser is served from public/ rather than imported with `?url`, because
 * subtitles.ts is reachable from both the page graph and the worker graph and
 * each one emitted its own copy of the same 147 kB file. Copying it on install
 * means a version bump cannot leave the served copy behind.
 */
import { copyFileSync, mkdirSync } from 'node:fs'

// `npm ci` runs before the rest of the tree is copied in the Docker build, so
// public/ need not exist yet; the real one lands on top a layer later.
mkdirSync('public', { recursive: true })
copyFileSync('node_modules/matroska-subtitles/dist/matroska-subtitles.min.js', 'public/matroska-subtitles.min.js')
