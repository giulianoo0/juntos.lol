import { describe, expect, it } from 'vitest'
import vector from './dm-vector.json'
import { deriveWrapKey, exportDeviceKey, fromBase64Url, generateDeviceKeys, importDeviceKey, KeyImportError, open, pairingCode, safetyNumber, seal, toBase64Url } from './crypto'

async function importPrivate(jwk: JsonWebKey) {
  return await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
}

describe('juntos-dm-v1', () => {
  it('opens on every device it was sealed for, and nowhere else', async () => {
    const ana = await generateDeviceKeys()
    const bia = await generateDeviceKeys()
    const eve = await generateDeviceKeys()
    const toBia = await deriveWrapKey(ana.privateKey, 'ana-1', bia.publicKey, 'bia-1')
    const toSelf = await deriveWrapKey(ana.privateKey, 'ana-1', ana.publicKey, 'ana-1')
    const sealed = await seal('oi, bora ver hoje?', 1, 2, 'cli-1', [
      { deviceId: 'bia-1', wrapKey: toBia },
      { deviceId: 'ana-1', wrapKey: toSelf },
    ])
    const message = { from: 1, to: 2, clientId: 'cli-1', iv: sealed.iv, body: sealed.body }

    const atBia = await deriveWrapKey(bia.privateKey, 'bia-1', ana.publicKey, 'ana-1')
    expect(await open(message, sealed.keys['bia-1']!, atBia)).toBe('oi, bora ver hoje?')
    expect(await open(message, sealed.keys['ana-1']!, toSelf)).toBe('oi, bora ver hoje?')

    const atEve = await deriveWrapKey(eve.privateKey, 'bia-1', ana.publicKey, 'ana-1')
    await expect(open(message, sealed.keys['bia-1']!, atEve)).rejects.toThrow()
  })

  it('refuses a message moved to another pair of accounts', async () => {
    const ana = await generateDeviceKeys()
    const bia = await generateDeviceKeys()
    const wrap = await deriveWrapKey(ana.privateKey, 'a', bia.publicKey, 'b')
    const sealed = await seal('segredo', 1, 2, 'cli-2', [{ deviceId: 'b', wrapKey: wrap }])
    const atBia = await deriveWrapKey(bia.privateKey, 'b', ana.publicKey, 'a')
    await expect(open({ from: 3, to: 2, clientId: 'cli-2', iv: sealed.iv, body: sealed.body }, sealed.keys.b!, atBia)).rejects.toThrow()
  })

  it('opens the fixed vector the Android app checks too', async () => {
    const bia = await importPrivate(vector.recipientPrivateJwk as JsonWebKey)
    const wrap = await deriveWrapKey(bia, vector.recipientDevice, vector.senderPublicKey, vector.senderDevice)
    expect(await open(vector.message, vector.wrapped, wrap)).toBe(vector.text)
  })

  it('round-trips base64url and agrees on the codes', async () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63])
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes)
    expect(await safetyNumber(['b', 'a'])).toBe(await safetyNumber(['a', 'b']))
    expect(await pairingCode('x')).toMatch(/^[A-Z2-9]{6}$/)
  })

  it('carries a device key to another device of the same account, and to no other', async () => {
    const keys = await generateDeviceKeys()
    const device = { accountId: 7, deviceId: 'dev-7', ...keys }
    const text = await exportDeviceKey(device)
    expect(text).toMatch(/^juntos-key:/)

    const taken = await importDeviceKey(` ${text!.slice(0, 40)}\n${text!.slice(40)} `, 7)
    expect(taken.deviceId).toBe('dev-7')
    expect(taken.publicKey).toBe(keys.publicKey)
    const other = await generateDeviceKeys()
    const there = await deriveWrapKey(taken.privateKey, 'dev-7', other.publicKey, 'o')
    const here = await deriveWrapKey(other.privateKey, 'o', keys.publicKey, 'dev-7')
    const sealed = await seal('mesma chave', 7, 8, 'c', [{ deviceId: 'dev-7', wrapKey: here }])
    expect(await open({ from: 7, to: 8, clientId: 'c', iv: sealed.iv, body: sealed.body }, sealed.keys['dev-7']!, there)).toBe('mesma chave')

    await expect(importDeviceKey(text!, 8)).rejects.toEqual(new KeyImportError('other_account'))
    await expect(importDeviceKey('juntos-key:abc', 7)).rejects.toBeInstanceOf(KeyImportError)
  })

  it('reads the key the Android app writes', async () => {
    const taken = await importDeviceKey(vector.carried, vector.carriedAccount)
    expect(taken.publicKey).toBe(vector.carriedPublic)
  })
})
