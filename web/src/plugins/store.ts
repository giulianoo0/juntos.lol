import type { PluginManifest } from './manifest'

export type PluginOrigin =
  | { kind: 'file'; fileName: string; updateUrl: string | null }
  | { kind: 'git'; updateUrl: string; commit: string }

/** A newer version held back because it wants hosts the install never approved. */
export interface PendingUpdate {
  source: string
  sha256: string
  manifest: PluginManifest
  commit: string
  newHosts: string[]
}

export interface InstalledPlugin {
  id: string
  manifest: PluginManifest
  source: string
  sha256: string
  origin: PluginOrigin
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
    request.onblocked = () => reject(new Error('plugin registry: another tab is holding an older version open'))
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); forget() }
      db.onclose = forget
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('plugin registry failed to open'))
  })

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
 * Locked at install and never rewritten, so an update cannot redirect its own
 * channel. Excludes the commit and a file's later-learned `updateUrl`.
 */
export function originKey(origin: PluginOrigin): string {
  return origin.kind === 'git' ? `git:${origin.updateUrl}` : `file:${origin.fileName}`
}

export function originId(origin: PluginOrigin): Promise<string> {
  return sha256Hex(originKey(origin))
}

export async function sha256Hex(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
