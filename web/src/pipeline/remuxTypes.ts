/**
 * The shape of a preparo, with nothing behind it.
 *
 * These declarations sit apart from remuxJob so the page can name a job
 * without loading one. remuxJob reaches mediabunny and its WASM decoders
 * through clientMedia and mediaInput, and a single value import of
 * `sourceSize` from the upload path was enough to weld that whole engine —
 * over a megabyte of it — into the chunk the browser parses before it can
 * draw anything. Everything here is data and arithmetic; the types it borrows
 * are type-only, which no bundler follows.
 */
import type { MediaInput } from './mediaInput'
import type { TorrentVideoFile, WorkerGrant } from '../torrent'

// Every source the site can play, as data. The last two are the page-bound
// escape hatches — a live MediaInput, or a torrent file read through the
// session's own callbacks — which cannot cross into a worker and pin the job
// to the page's thread (mocks and tests live there).
export type RemuxSource =
  | { kind: 'file'; file: File }
  | { kind: 'stream'; url: string; name: string; size: number }
  | { kind: 'url'; url: string; name: string; size: number }
  | { kind: 'worker'; grant: WorkerGrant }
  | { kind: 'torrentFile'; file: TorrentVideoFile }
  | { kind: 'input'; input: MediaInput }

// A subtitle file shipped next to the video. With a url it clones into the
// worker; a read function pins the job to the page like 'input' does.
export interface RemuxSideFile {
  name: string
  path: string
  size: number
  url?: string
  // A sibling of a worker-served video: read through the video's own input,
  // so the ticket in the url is whichever is current, not the one at start.
  workerIndex?: number
  read?: () => Promise<ArrayBuffer>
}

export interface RemuxJob {
  roomID: string
  mediaGeneration: number
  source: RemuxSource
  sideFiles: RemuxSideFile[]
}

/** Whether the source is plain data, or holds functions only this page has. */
export function sourceIsCloneable(source: RemuxSource): boolean {
  return source.kind !== 'input' && source.kind !== 'torrentFile'
}

export function sourceSize(source: RemuxSource): number {
  return source.kind === 'file' ? source.file.size
    : source.kind === 'input' ? source.input.size
    : source.kind === 'worker' ? source.grant.size
    : source.kind === 'torrentFile' ? source.file.size
    : source.size
}

/** Whether the job is plain data end to end and may cross into a worker. */
export function jobIsCloneable(job: RemuxJob): boolean {
  return sourceIsCloneable(job.source) && job.sideFiles.every((file) => file.url !== undefined || file.workerIndex !== undefined)
}
