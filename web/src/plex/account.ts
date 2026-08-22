/**
 * Pairing with a Plex account, and the credential it produces.
 *
 * We never ask for the person's Plex password. The PIN flow is what Plex
 * offers third-party clients: we ask for a code, they approve it inside Plex
 * itself, and we poll until a token comes back.
 *
 * The token lives in IndexedDB rather than localStorage. It is an account
 * credential, not a preference, and it should be as easy to delete as it was
 * to obtain — see clearToken, which the panel's disconnect button calls.
 */

export interface PlexDeps {
  fetch?: typeof globalThis.fetch
}

const DB_NAME = 'ss-plex'
const DB_VERSION = 1
const STORE = 'account'
const TOKEN_KEY = 'authToken'
const CLIENT_KEY = 'clientIdentifier'

const PRODUCT = 'ss'
const VERSION = '1.0.0'

let connection: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (connection) return connection
  let cached: Promise<IDBDatabase>
  const forget = () => { if (connection === cached) connection = null }

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onblocked = () => reject(new Error('plex store: another tab is holding an older version open'))
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); forget() }
      db.onclose = forget
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('plex store failed to open'))
  })
  cached = opening.catch((error: unknown) => { forget(); throw error })
  connection = cached
  return cached
}

function read(key: string): Promise<string | null> {
  return open().then((db) => new Promise<string | null>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly')
    const request = transaction.objectStore(STORE).get(key) as IDBRequest<string | undefined>
    transaction.oncomplete = () => resolve(request.result ?? null)
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('plex store read failed'))
  }))
}

function write(key: string, value: string | null): Promise<void> {
  return open().then((db) => new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    if (value === null) store.delete(key)
    else store.put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('plex store write failed'))
  }))
}

/**
 * This installation's opaque identity, as far as plex.tv is concerned.
 *
 * It is not optional: `POST /api/v2/pins` answers 400 without it, and so does
 * resource discovery. It has to be the same value across both and across
 * restarts, or a pin approved under one identity is invisible to the other.
 */
export async function clientIdentifier(): Promise<string> {
  const existing = await read(CLIENT_KEY)
  if (existing) return existing
  const fresh = crypto.randomUUID()
  await write(CLIENT_KEY, fresh)
  return fresh
}

export async function plexHeaders(): Promise<Record<string, string>> {
  return {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': VERSION,
    'X-Plex-Client-Identifier': await clientIdentifier(),
  }
}

export async function createPin(deps: PlexDeps = {}): Promise<{ id: number; code: string; authUrl: string }> {
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const response = await request('https://plex.tv/api/v2/pins?strong=true', {
    method: 'POST',
    headers: await plexHeaders(),
  })
  // 201 Created is what this endpoint actually answers.
  if (!response.ok) throw new Error(`plex pin request failed (${response.status})`)
  const body = await response.json() as { id?: unknown; code?: unknown }
  if (typeof body.id !== 'number' || typeof body.code !== 'string') {
    throw new Error('plex pin request returned no pin')
  }
  const params = new URLSearchParams({
    clientID: await clientIdentifier(),
    code: body.code,
    'context[device][product]': PRODUCT,
  })
  return { id: body.id, code: body.code, authUrl: `https://app.plex.tv/auth#?${params.toString()}` }
}

export async function pollPin(id: number, deps: PlexDeps = {}): Promise<string | null> {
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const response = await request(`https://plex.tv/api/v2/pins/${id}`, { headers: await plexHeaders() })
  // A pin expires after a few minutes, and plex.tv answers 404 both for that
  // and for a pin asked about under a different client identifier. Reporting
  // either as "still waiting" would poll for ever against something that will
  // never answer; both are fixed by pairing again.
  if (response.status === 404) throw new Error('plex pin expired')
  if (!response.ok) throw new Error(`plex pin poll failed (${response.status})`)
  const body = await response.json() as { authToken?: unknown }
  return typeof body.authToken === 'string' && body.authToken !== '' ? body.authToken : null
}

export function getToken(): Promise<string | null> {
  return read(TOKEN_KEY)
}

export function setToken(token: string): Promise<void> {
  return write(TOKEN_KEY, token)
}

export function clearToken(): Promise<void> {
  return write(TOKEN_KEY, null)
}
