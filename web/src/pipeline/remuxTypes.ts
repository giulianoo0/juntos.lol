/**
 * The shape of a preparo, with nothing behind it: apart from remuxJob so the
 * page can name a job without welding mediabunny and its WASM (over a MB) into
 * the first-paint chunk. Anything borrowed here must stay a type-only import.
 */
import type { MediaInput } from './mediaInput'

export type RemuxSource =
  | { kind: 'file'; file: File }
  | { kind: 'stream'; url: string; name: string; size: number }
  | { kind: 'url'; url: string; name: string; size: number }
  | { kind: 'input'; input: MediaInput }

export interface RemuxSideFile {
  name: string
  path: string
  size: number
  url?: string
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
  return source.kind !== 'input'
}

export function sourceSize(source: RemuxSource): number {
  return source.kind === 'file' ? source.file.size
    : source.kind === 'input' ? source.input.size
    : source.size
}

/** Whether the job is plain data end to end and may cross into a worker. */
export function jobIsCloneable(job: RemuxJob): boolean {
  return sourceIsCloneable(job.source) && job.sideFiles.every((file) => file.url !== undefined)
}
