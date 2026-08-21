import { webcrypto } from 'node:crypto'

/**
 * jsdom ships `Crypto` without `SubtleCrypto`, and the plugin registry
 * identifies both a plugin's version and its origin by SHA-256. It also has
 * no `randomUUID`, which is how the Plex client names itself to plex.tv.
 *
 * This lives outside `src` on purpose: it is the only Node-land file in the
 * test setup, and importing `node:crypto` from `src` would mean adding Node's
 * types to the application's tsconfig — which would then let browser code
 * reach for Node globals that do not exist in a browser.
 */
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
}
