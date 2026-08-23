/**
 * What the client pipeline reads from. Every source the site can play — a
 * picked file, a torrent the ss-bridge is downloading, a url a plugin handed
 * over — is reduced to the same two things: a size, and a way to read any
 * byte range. The remuxer does random access (an MKV's cues sit at the end,
 * an MP4's moov often does), so a sequential stream would not do.
 */
import { BlobSource, CustomSource, UrlSource, type Source } from 'mediabunny'
import type { TorrentVideoFile } from '../torrent'

export interface MediaInput {
  name: string
  size: number
  /** Reads `[start, end)`, like `Blob.slice`. */
  read(start: number, end: number): Promise<Uint8Array>
  /** A fresh mediabunny source over the same bytes. */
  source(): Source
}

export function fileInput(file: File): MediaInput {
  return {
    name: file.name,
    size: file.size,
    read: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
    source: () => new BlobSource(file),
  }
}

/**
 * A torrent file served by the ss-bridge. The helper answers a range once
 * those pieces have downloaded and raises their priority for the wait, so
 * reading the tail first costs a seek in the swarm, not a full download.
 */
export function torrentInput(file: TorrentVideoFile): MediaInput {
  const read = async (start: number, end: number): Promise<Uint8Array> => {
    const clamped = Math.min(end, file.size)
    if (clamped <= start) return new Uint8Array(0)
    return new Uint8Array(await file.read(start, clamped - 1))
  }
  return {
    name: file.name,
    size: file.size,
    read,
    source: () => new CustomSource({
      read,
      getSize: async () => file.size,
      // The helper sits on loopback, but every read still waits on the swarm;
      // the network profile batches reads and prefetches ahead on sequential
      // access, which is what the remux mostly does.
      prefetchProfile: 'network',
    }),
  }
}

/**
 * A url a plugin produced, read straight from this browser. The origin has to
 * allow it (CORS, and Range requests): there is no server in between any more
 * to fetch on the page's behalf.
 */
export function urlInput(url: string, name: string, size: number): MediaInput {
  const read = async (start: number, end: number): Promise<Uint8Array> => {
    const response = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } })
    if (!response.ok && response.status !== 206) throw new Error(`url read failed (${response.status})`)
    return new Uint8Array(await response.arrayBuffer())
  }
  return {
    name,
    size,
    read,
    source: () => new UrlSource(url),
  }
}
