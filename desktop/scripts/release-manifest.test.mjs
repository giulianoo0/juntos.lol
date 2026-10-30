import assert from 'node:assert/strict'
import { test } from 'node:test'
import { manifest } from './release-manifest.mjs'

const base = 'https://github.com/giulianoo0/juntos.lol/releases/download/desktop-v0.1.1'

test('every platform the release holds is in latest.json, with its signature', () => {
  const out = manifest({
    version: '0.1.1',
    notes: 'Correções',
    pubDate: '2026-10-30T00:00:00Z',
    base,
    signatures: { 'Juntos.app.tar.gz': 'MAC', 'Juntos-setup.exe': 'WIN', 'Juntos.AppImage': 'LIN' },
  })
  assert.equal(out.version, '0.1.1')
  assert.equal(out.notes, 'Correções')
  assert.equal(out.pub_date, '2026-10-30T00:00:00Z')
  for (const key of ['darwin-universal', 'darwin-aarch64', 'darwin-x86_64']) {
    assert.deepEqual(out.platforms[key], { signature: 'MAC', url: `${base}/Juntos.app.tar.gz` })
  }
  assert.deepEqual(out.platforms['windows-x86_64'], { signature: 'WIN', url: `${base}/Juntos-setup.exe` })
  assert.deepEqual(out.platforms['linux-x86_64'], { signature: 'LIN', url: `${base}/Juntos.AppImage` })
})

test('a platform not uploaded yet is left out, not pointed at nothing', () => {
  const out = manifest({ version: '0.1.1', notes: '', pubDate: 'x', base, signatures: { 'Juntos-setup.exe': 'WIN' } })
  assert.deepEqual(Object.keys(out.platforms), ['windows-x86_64'])
})
