import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The TV only watches, on a TV's memory: what prepares media (the remux, the
 * host's pipeline, a local torrent, the companion app, the desktop app's
 * sources, publishing to the relay) must stay out of what /tv loads. This
 * walks the static imports from the TV's page, as the bundler does; a dynamic
 * import() loads only when something on the TV calls it, and nothing does.
 */
const SRC = resolve(__dirname, '..')

function staticImports(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const found: string[] = []
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^'"]*?)from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) {
    if (match[1]) continue
    const names = (match[2] ?? '').replace(/[{}]/g, '').split(',').map((name) => name.trim()).filter(Boolean)
    if (names.length > 0 && names.every((name) => name.startsWith('type '))) continue
    found.push(match[3] ?? match[4]!)
  }
  return found
}

function resolveImport(from: string, specifier: string): string {
  if (!specifier.startsWith('.')) return `package:${specifier}`
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return base
}

function loadedBy(entry: string): Set<string> {
  const seen = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    if (!/\.tsx?$/.test(file)) return
    for (const specifier of staticImports(file)) walk(resolveImport(file, specifier))
  }
  walk(resolve(SRC, entry))
  return new Set([...seen].map((file) => file.startsWith('package:') ? file : relative(SRC, file)))
}

const PREPARES_MEDIA = [
  /^package:mediabunny/,
  /^package:@mediabunny\//,
  /^package:@moq\/publish/,
  /^package:@tauri-apps\//,
  /^pipeline\/(remuxJob|clientMedia|remuxWorker|mediaInput|byteTap|rangeRead|segmentLedger)\.ts$/,
  /^jlocal\/(production|youtube|torrent|audio|capabilities|askScreenPermission)\.ts$/,
  /^desktop\/sources\.ts$/,
  /^torrent\.ts$/,
  /^live\.ts$/,
  /^screen\/(useScreenShare|JlocalPicker|AppScreenPicker|ScreenStage)\.tsx?$/,
  /^catalog\//,
  /^components\/(TorrentPicker|DrivePicker|YoutubePicker)\.tsx$/,
  /^pages\/Room\.tsx$/,
]

describe('a página da TV', () => {
  it('não carrega nada que prepara mídia', () => {
    const loaded = [...loadedBy('tv/TvApp.tsx')]
    expect(loaded.filter((file) => PREPARES_MEDIA.some((pattern) => pattern.test(file)))).toEqual([])
  })

  it('carrega o que assiste: player, relay, chamada e legendas ASS', () => {
    const loaded = loadedBy('tv/TvApp.tsx')
    for (const file of ['player/Player.tsx', 'player/AssLayer.tsx', 'screenshare.ts', 'call/useCall.ts', 'player/useSync.ts']) {
      expect(loaded).toContain(file)
    }
  })
})
