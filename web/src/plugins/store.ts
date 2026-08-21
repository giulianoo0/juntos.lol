import type { PluginManifest } from './manifest'

/** Where a plugin came from, and whether it has a home to update from. */
export type PluginOrigin =
  | { kind: 'file'; fileName: string; updateUrl: string | null }
  | { kind: 'git'; updateUrl: string; commit: string }

/**
 * A newer version held back because it wants hosts the install never
 * approved. It sits here until the person says yes.
 */
export interface PendingUpdate {
  source: string
  sha256: string
  manifest: PluginManifest
  commit: string
  newHosts: string[]
}

export interface InstalledPlugin {
  /**
   * The registry key: a hash of the origin, never `manifest.id`.
   *
   * Keyed by what the manifest calls itself, installing any repository that
   * declared `id: 'torrentio'` would silently overwrite the installed
   * Torrentio — its origin, its approved hosts and its code.
   */
  id: string
  manifest: PluginManifest
  source: string
  sha256: string
  origin: PluginOrigin
  /** Hosts agreed to at install. The policy uses these, not the manifest's. */
  approvedHosts: string[]
  enabled: boolean
  pendingUpdate: PendingUpdate | null
  installedAt: number
}

const DB_NAME = 'ss-plugins'
const DB_VERSION = 1
const STORE = 'plugins'

let connection: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (connection) return connection
  let cached: Promise<IDBDatabase>
  const forget = () => { if (connection === cached) connection = null }

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    // Another tab is holding an older version open. Without this the promise
    // never settles at all — no value, no error, just a caller left hanging.
    request.onblocked = () => reject(new Error('plugin registry: another tab is holding an older version open'))
    request.onsuccess = () => {
      const db = request.result
      // Another tab wants to upgrade: let go, rather than blocking it for ever.
      db.onversionchange = () => { db.close(); forget() }
      // The browser can close the connection on its own. A dead handle left in
      // the cache makes every later transaction throw InvalidStateError.
      db.onclose = forget
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('plugin registry failed to open'))
  })

  // A failed open must not be cached: it would leave the registry dead until
  // a reload, with no way to retry.
  cached = opening.catch((error: unknown) => {
    forget()
    throw error
  })
  connection = cached
  return cached
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode)
    const request = work(transaction.objectStore(STORE))
    // Read at commit time, when `request.result` is already filled in.
    // Resolving on the request instead would call a write successful before
    // it committed, and a commit can still fail after that.
    transaction.oncomplete = () => resolve(request.result)
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? request.error ?? new Error('plugin registry request failed'))
  }))
}

export function listPlugins(): Promise<InstalledPlugin[]> {
  return run<InstalledPlugin[]>('readonly', (store) => store.getAll() as IDBRequest<InstalledPlugin[]>)
}

export function getPlugin(id: string): Promise<InstalledPlugin | null> {
  return run<InstalledPlugin | undefined>('readonly', (store) => store.get(id) as IDBRequest<InstalledPlugin | undefined>)
    .then((value) => value ?? null)
}

export function putPlugin(plugin: InstalledPlugin): Promise<void> {
  return run('readwrite', (store) => store.put(plugin) as IDBRequest<IDBValidKey>).then(() => undefined)
}

export function deletePlugin(id: string): Promise<void> {
  return run('readwrite', (store) => store.delete(id) as IDBRequest<undefined>).then(() => undefined)
}

/**
 * A plugin's identity: where it came from, never what it calls itself.
 *
 * Locked at install and never rewritten, which is what makes an update unable
 * to redirect its own update channel — the `known_hosts` argument.
 *
 * Deliberately excludes the commit and a file's later-learned `updateUrl`:
 * both change over the life of one plugin, and an identity that changes is
 * not an identity.
 */
export function originKey(origin: PluginOrigin): string {
  return origin.kind === 'git' ? `git:${origin.updateUrl}` : `file:${origin.fileName}`
}

export function originId(origin: PluginOrigin): Promise<string> {
  return sha256Hex(originKey(origin))
}

/** Identifies a version of a plugin's code, for display and for comparison. */
export async function sha256Hex(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
