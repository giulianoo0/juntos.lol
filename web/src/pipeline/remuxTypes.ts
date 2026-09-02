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

export type RemuxSource =
  | { kind: 'file'; file: File }
  | { kind: 'stream'; url: string; name: string; size: number }
  | { kind: 'url'; url: string; name: string; size: number }
  | { kind: 'worker'; grant: WorkerGrant }
  | { kind: 'torrentFile'; file: TorrentVideoFile }
  | { kind: 'input'; input: MediaInput }

export interface RemuxSideFile {
  name: string
  path: string
  size: number
  url?: string
  workerIndex?: number
  read?: () => Promise<ArrayBuffer>
}

export interface RemuxJob {
  roomID: string
  mediaGeneration: number
  source: RemuxSource
  sideFiles: RemuxSideFile[]
  subtitlesOnly?: boolean
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
