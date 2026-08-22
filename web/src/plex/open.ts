import { rangeSource, type ChunkSource } from '../upload'
import { partUrl, type PlexItem } from './library'
import type { PlexConnection } from './server'

export type PlexOpen =
  | { kind: 'server-pull'; url: string; fileName: string; size: number }
  | { kind: 'browser-pump'; source: ChunkSource; fileName: string; size: number }

/**
 * Decides who fetches the bytes.
 *
 * A public connection goes to the server, which means the transfer survives
 * the host closing the tab. A LAN connection cannot: the server has no route
 * to a private address and is not going to be given one — the SSRF guard
 * exists precisely so that it never will. A relay could go either way and
 * goes to the browser on purpose, because relay bandwidth belongs to the
 * account holder and is not ours to spend on their behalf.
 */
export function openPlexItem(connection: PlexConnection, item: PlexItem, token: string): PlexOpen {
  const url = partUrl(connection.uri, item.partKey, token)
  const fileName = `${item.title}.${item.container}`
  if (connection.local || connection.relay) {
    // The browser pump loops `while (offset < size)` and creates the tus
    // upload with `Upload-Length: size`. A zero there uploads nothing, ends
    // immediately, and reports success — an empty file in the room with no
    // error anywhere. The server path survives it because the ingestor asks
    // the origin, but nothing here can.
    if (item.size <= 0) {
      throw new Error('plex did not report this file size, and it can only be reached on the local network')
    }
    return { kind: 'browser-pump', source: rangeSource(url, fileName, item.size), fileName, size: item.size }
  }
  return { kind: 'server-pull', url, fileName, size: item.size }
}
