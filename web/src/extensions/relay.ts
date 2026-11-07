import type { MediaRelay } from '../pipeline/hlsInput'
import { settledDesktop, type DesktopApp } from '../platform'
import { extensionOrigin, type ExtHeaders, type ExtensionPlace } from './protocol'

/**
 * The extension's media proxy, for a CDN that sends no CORS. Each url it
 * reads needs a ticket juntos signs; a playlist comes back with its segments
 * already pointing at the proxy, ticket and all.
 */
export function extensionRelay(sub: string, place?: ExtensionPlace, get: typeof fetch = fetch): MediaRelay {
  const prefix = `${extensionOrigin(sub, place)}/_juntos/media?`
  return {
    async via(url) {
      const response = await get('/api/extensions/media-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub, url }),
      })
      if (!response.ok) throw new Error(`media ticket refused (${response.status})`)
      const { ticket } = await response.json() as { ticket?: unknown }
      if (typeof ticket !== 'string') throw new Error('media ticket missing')
      return `${prefix}u=${encodeURIComponent(url)}&t=${encodeURIComponent(ticket)}`
    },
    owns: (url) => url.startsWith(prefix),
  }
}

/**
 * Where an extension's media goes when the browser cannot read it. One that
 * reaches any host has no proxy: the Worker would be a relay to anywhere.
 */
export function relayFor(extension: { sub: string; manifest: { hosts: { media: readonly string[] } } }, place?: ExtensionPlace): MediaRelay | undefined {
  if (extension.manifest.hosts.media.includes('*')) return undefined
  return extensionRelay(extension.sub, place)
}

function base64url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The desktop app's media proxy: reads on the person's own network, any
 * scheme the source came with, with the headers the CDN wants. Undefined in
 * a browser or an app that does not have it.
 */
export function appRelay(headers?: ExtHeaders, app: DesktopApp | null = settledDesktop()): MediaRelay | undefined {
  if (!app?.mediaProxyKey || !app.features.includes('mediaProxy')) return undefined
  const prefix = `${app.mediaRoot}/_proxy?`
  const key = encodeURIComponent(app.mediaProxyKey)
  const sent = headers && Object.keys(headers).length > 0 ? `&h=${base64url(JSON.stringify(headers))}` : ''
  return {
    via: async (url) => `${prefix}u=${encodeURIComponent(url)}&k=${key}${sent}`,
    owns: (url) => url.startsWith(prefix),
  }
}

/** Whether this page can play what only the app reads. */
export function appReads(): boolean {
  return appRelay() !== undefined
}
