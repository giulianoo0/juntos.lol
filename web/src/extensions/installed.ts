/**
 * The extensions this device approved, and at which version. An update that
 * reaches the same hosts goes through on its own; one that asks for new
 * hosts waits for the person to see them.
 */
import type { ExtensionManifest } from './protocol'
import { latestExtension, parseManifest } from './registry'

export interface InstalledExtension {
  id: string
  sub: string
  version: string
  manifest: ExtensionManifest
}

export type Update =
  | { kind: 'current' }
  | { kind: 'silent'; version: string; manifest: ExtensionManifest }
  | { kind: 'approve'; version: string; manifest: ExtensionManifest }

const KEY = 'ss.extensions'

function readAll(): Record<string, InstalledExtension> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, InstalledExtension> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<InstalledExtension> | null
      const manifest = parseManifest(entry?.manifest)
      if (!entry || entry.id !== id || typeof entry.sub !== 'string' || typeof entry.version !== 'string' || manifest?.id !== id) continue
      out[id] = { id, sub: entry.sub, version: entry.version, manifest }
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, InstalledExtension>): void {
  try { localStorage.setItem(KEY, JSON.stringify(all)) } catch {}
}

export function installedExtension(id: string): InstalledExtension | null {
  return readAll()[id] ?? null
}

/** Everything this device installed, by name; nothing comes installed. */
export function listInstalled(): InstalledExtension[] {
  return Object.values(readAll()).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
}

export function saveInstalled(entry: InstalledExtension): void {
  writeAll({ ...readAll(), [entry.id]: entry })
}

export function forgetInstalled(id: string): void {
  const all = readAll()
  delete all[id]
  writeAll(all)
}

function hostSet(manifest: ExtensionManifest): string {
  const { connect, images, media } = manifest.hosts
  return JSON.stringify([connect, images, media].map((list) => [...list].sort()))
}

/** What to do with `next` given what this device approved. */
export function updateFor(installed: InstalledExtension | null, next: { version: string; manifest: ExtensionManifest }): Update {
  if (installed && installed.version === next.version) return { kind: 'current' }
  if (installed && hostSet(installed.manifest) === hostSet(next.manifest) && installed.manifest.captcha === next.manifest.captcha) {
    return { kind: 'silent', ...next }
  }
  return { kind: 'approve', ...next }
}

/**
 * `installed` at the version juntos serves now, which is the only one the
 * extension host answers for. An update that reaches the same hosts is saved
 * on the way; one that asks for more gives null until the person approves it.
 */
export async function freshInstalled(installed: InstalledExtension, raw?: string): Promise<InstalledExtension | null> {
  const next = await latestExtension(installed.id, raw)
  const update = updateFor(installed, next)
  if (update.kind === 'current') return installed
  if (update.kind === 'approve') return null
  saveInstalled(next)
  return next
}
