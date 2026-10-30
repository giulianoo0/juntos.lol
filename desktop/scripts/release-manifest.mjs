// Refaz o latest.json (updater) e o SHA256SUMS.txt de uma release do GitHub
// com o que ela já tem, e sobe os dois por cima.
//   node scripts/release-manifest.mjs giulianoo0/juntos.lol desktop-v0.1.1
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLATFORMS = {
  'Juntos.app.tar.gz': ['darwin-universal', 'darwin-aarch64', 'darwin-x86_64'],
  'Juntos-setup.exe': ['windows-x86_64'],
  'Juntos.AppImage': ['linux-x86_64'],
}
const DOWNLOADS = ['Juntos.dmg', 'Juntos-setup.exe', 'Juntos.AppImage']

export function manifest({ version, notes, pubDate, base, signatures }) {
  const platforms = {}
  for (const [asset, keys] of Object.entries(PLATFORMS)) {
    const signature = signatures[asset]
    if (!signature) continue
    for (const key of keys) platforms[key] = { signature, url: `${base}/${asset}` }
  }
  return { version, notes, pub_date: pubDate, platforms }
}

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

function main([repo, tag]) {
  if (!repo || !tag) throw new Error('uso: release-manifest.mjs <owner/repo> <tag>')
  const release = JSON.parse(gh('release', 'view', tag, '--repo', repo, '--json', 'body,assets,publishedAt'))
  const names = new Set(release.assets.map((a) => a.name))
  const want = [
    ...Object.keys(PLATFORMS).filter((n) => names.has(n) && names.has(`${n}.sig`)).map((n) => `${n}.sig`),
    ...DOWNLOADS.filter((n) => names.has(n)),
  ]
  const dir = mkdtempSync(join(tmpdir(), 'juntos-release-'))
  for (const name of want) gh('release', 'download', tag, '--repo', repo, '--dir', dir, '--pattern', name, '--clobber')

  const signatures = {}
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sig'))) {
    signatures[file.slice(0, -4)] = readFileSync(join(dir, file), 'utf8').trim()
  }
  const out = manifest({
    version: tag.replace(/^desktop-v/, ''),
    notes: release.body ?? '',
    pubDate: release.publishedAt || new Date().toISOString(),
    base: `https://github.com/${repo}/releases/download/${tag}`,
    signatures,
  })
  const sums = DOWNLOADS.filter((n) => names.has(n))
    .map((n) => `${createHash('sha256').update(readFileSync(join(dir, n))).digest('hex')}  ${n}`)
    .join('\n')

  writeFileSync(join(dir, 'latest.json'), JSON.stringify(out, null, 2) + '\n')
  writeFileSync(join(dir, 'SHA256SUMS.txt'), sums + '\n')
  gh('release', 'upload', tag, '--repo', repo, '--clobber', join(dir, 'latest.json'), join(dir, 'SHA256SUMS.txt'))
  console.log(`latest.json: ${Object.keys(out.platforms).join(', ') || 'nenhuma plataforma'}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
