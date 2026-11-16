import { describe, expect, it } from 'vitest'
import vector from './dm-vector.json'
import { deriveWrapKey, fromBase64Url, generateDeviceKeys, open, pairingCode, safetyNumber, seal, toBase64Url } from './crypto'

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
})
