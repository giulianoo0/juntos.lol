/**
 * End-to-end encryption of private messages (scheme `juntos-dm-v1`).
 *
 * Every device holds a P-256 key pair whose private half stays in IndexedDB and
 * leaves only when its owner carries it to another device of theirs
 * (`exportDeviceKey`). A message is sealed with a fresh
 * 256-bit key under AES-GCM, with `from>to:clientId` as associated data, and
 * that key is wrapped, once per device of both accounts, under AES-GCM with a
 * key-encryption key both ends derive alone:
 *
 *   KEK = HKDF-SHA256(ECDH(mine, theirs), salt "juntos-dm-v1", info "wrap:" + both device ids sorted, joined by ":")
 *
 * The wrap's associated data is the client id, so a key cannot be moved to
 * another message. The Android app implements the same, byte for byte.
 */

const SCHEME = 'juntos-dm-v1'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n))
}

export interface DeviceKeys {
  privateKey: CryptoKey
  /** The public half, raw uncompressed point in base64url. */
  publicKey: string
}

export async function generateDeviceKeys(): Promise<DeviceKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: toBase64Url(raw) }
}

async function importPublic(publicKey: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', fromBase64Url(publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
}

/** The key two devices share for wrapping; the same from either end. */
export async function deriveWrapKey(mine: CryptoKey, myDevice: string, theirPublic: string, theirDevice: string): Promise<CryptoKey> {
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublic(theirPublic) }, mine, 256)
  const hkdf = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey'])
  const ids = [myDevice, theirDevice].sort()
  return await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(SCHEME), info: encoder.encode(`wrap:${ids.join(':')}`) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export interface Wrapped { iv: string; key: string }

export interface Sealed {
  iv: string
  body: string
  keys: Record<string, Wrapped>
}

export interface Recipient {
  deviceId: string
  /** The key shared with this device, from deriveWrapKey. */
  wrapKey: CryptoKey
}

function messageAad(from: number, to: number, clientId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${from}>${to}:${clientId}`)
}

/** Seals `text` for every recipient device. */
export async function seal(text: string, from: number, to: number, clientId: string, recipients: Recipient[]): Promise<Sealed> {
  const raw = randomBytes(32)
  const messageKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt'])
  const iv = randomBytes(12)
  const plain = encoder.encode(JSON.stringify({ t: text }))
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: messageAad(from, to, clientId) }, messageKey, plain))
  const keys: Record<string, Wrapped> = {}
  for (const recipient of recipients) {
    const wrapIv = randomBytes(12)
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv, additionalData: encoder.encode(clientId) }, recipient.wrapKey, raw))
    keys[recipient.deviceId] = { iv: toBase64Url(wrapIv), key: toBase64Url(wrapped) }
  }
  return { iv: toBase64Url(iv), body: toBase64Url(body), keys }
}

/** Opens a message with this device's wrapped key and the key shared with the sender's device. */
export async function open(
  message: { from: number; to: number; clientId: string; iv: string; body: string },
  wrapped: Wrapped,
  wrapKey: CryptoKey,
): Promise<string> {
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(wrapped.iv), additionalData: encoder.encode(message.clientId) },
    wrapKey,
    fromBase64Url(wrapped.key),
  )
  const messageKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(message.iv), additionalData: messageAad(message.from, message.to, message.clientId) },
    messageKey,
    fromBase64Url(message.body),
  )
  const parsed = JSON.parse(decoder.decode(plain)) as { t?: unknown }
  if (typeof parsed.t !== 'string') throw new Error('bad message')
  return parsed.t
}

/** Short words both people can compare to know their keys were not swapped. */
export async function safetyNumber(publicKeys: string[]): Promise<string> {
  const joined = encoder.encode([...publicKeys].sort().join('|'))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', joined))
  const groups: string[] = []
  for (let i = 0; i < 6; i++) {
    const n = ((digest[i * 2]! << 8) | digest[i * 2 + 1]!) % 100000
    groups.push(String(n).padStart(5, '0'))
  }
  return groups.join(' ')
}

/** The six letters the browser shows when the desktop app signs in through it. */
export async function pairingCode(challenge: string): Promise<string> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`juntos-app-login:${challenge}`)))
  let code = ''
  for (let i = 0; i < 6; i++) code += alphabet[digest[i]! % alphabet.length]
  return code
}

// The device's keys live in IndexedDB, one record per account, holding the
// CryptoKey itself.
const DB_NAME = 'juntos-dm'
const STORE = 'devices'

export interface StoredDevice {
  accountId: number
  deviceId: string
  privateKey: CryptoKey
  publicKey: string
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: 'accountId' }) }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexeddb'))
  })
}

export async function loadDevice(accountId: number): Promise<StoredDevice | null> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(accountId)
      request.onsuccess = () => resolve((request.result as StoredDevice | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error('indexeddb'))
    })
  } finally {
    db.close()
  }
}

export async function saveDevice(device: StoredDevice): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(device)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('indexeddb'))
    })
  } finally {
    db.close()
  }
}

export async function forgetDevice(accountId: number): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(accountId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('indexeddb'))
    })
  } finally {
    db.close()
  }
}

/*
 * Carrying a device key to another device of the same account, as a QR or as
 * text: `juntos-key:` and base64url of {a: account, d: device, p: public, k: PKCS#8}.
 * The device that takes it reads everything the first one could.
 */
const KEY_PREFIX = 'juntos-key:'

export class KeyImportError extends Error {
  readonly reason: 'invalid' | 'other_account'
  constructor(reason: 'invalid' | 'other_account') {
    super(reason)
    this.reason = reason
  }
}

/** The device's key as text to carry, or null when it was made unexportable. */
export async function exportDeviceKey(device: StoredDevice): Promise<string | null> {
  if (!device.privateKey.extractable) return null
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', device.privateKey))
  const body = JSON.stringify({ a: device.accountId, d: device.deviceId, p: device.publicKey, k: toBase64Url(pkcs8) })
  return KEY_PREFIX + toBase64Url(encoder.encode(body))
}

export async function importDeviceKey(text: string, accountId: number): Promise<StoredDevice> {
  const trimmed = text.replace(/\s+/g, '')
  if (!trimmed.startsWith(KEY_PREFIX)) throw new KeyImportError('invalid')
  let parsed: { a?: unknown; d?: unknown; p?: unknown; k?: unknown }
  try {
    parsed = JSON.parse(decoder.decode(fromBase64Url(trimmed.slice(KEY_PREFIX.length))))
  } catch {
    throw new KeyImportError('invalid')
  }
  const { a, d, p, k } = parsed
  if (typeof a !== 'number' || typeof d !== 'string' || typeof p !== 'string' || typeof k !== 'string') throw new KeyImportError('invalid')
  if (a !== accountId) throw new KeyImportError('other_account')
  let privateKey: CryptoKey
  try {
    privateKey = await crypto.subtle.importKey('pkcs8', fromBase64Url(k), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  } catch {
    throw new KeyImportError('invalid')
  }
  // The public half travels along; it must be the private one's.
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const raw = new Uint8Array(65)
  raw[0] = 4
  raw.set(fromBase64Url(jwk.x!), 1)
  raw.set(fromBase64Url(jwk.y!), 33)
  if (toBase64Url(raw) !== p) throw new KeyImportError('invalid')
  return { accountId: a, deviceId: d, privateKey, publicKey: p }
}
