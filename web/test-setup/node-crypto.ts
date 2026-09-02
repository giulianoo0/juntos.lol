import { webcrypto } from 'node:crypto'

/**
 * jsdom ships `Crypto` without `SubtleCrypto` or `randomUUID`, both of which
 * the plugin registry needs. Outside `src` on purpose: importing `node:crypto`
 * from there would put Node's types on the application's tsconfig.
 */
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
}
