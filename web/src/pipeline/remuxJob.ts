/**
 * One room's whole preparo, described as plain data: rebuild the input,
 * remux it, publish the subtitles riding along. The description is
 * structured-cloneable on purpose — the job crosses into a Web Worker so the
 * demux, the mux and every upload stop sharing a thread with the page that
 * is drawing the player.
 */
import {
  createMatroskaSubtitleStream,
  createSubtitleCollector,
  isMatroska,
  type SubtitleCollector,
} from '../subtitles'
import { convertSubtitleFile, type VttTrack } from '../subtitleFormats'
import { fileInput, rangeInput, workerInput, type MediaInput } from './mediaInput'
import type { WorkerGrant } from '../torrent'
import { ReadAbortedError } from './rangeRead'
import { planClientRemux, runClientRemux, type ClientRemuxHandle } from './clientMedia'

// Headroom under the server's per-room track cap for the tracks muxed into
// the video itself.
const MAX_EXTERNAL_SUBTITLES = 16
// How often the cues seen so far are republished while bytes keep arriving.
const SUBTITLE_SNAPSHOT_MS = 8_000
// The slice a subtitle pass reads at a time. Big enough that a torrent read
// is worth the round trip, small enough to keep memory flat on a 50 GB file.
const SUBTITLE_SLICE_BYTES = 8 * 1024 * 1024

// Every source the site can play, as data. 'input' is the one page-bound
// escape hatch — a live MediaInput object that cannot cross into a worker
// and pins the job to the page's thread (mocks and tests live there).
export type RemuxSource =
  | { kind: 'file'; file: File }
  | { kind: 'stream'; url: string; name: string; size: number }
  | { kind: 'url'; url: string; name: string; size: number }
  | { kind: 'worker'; grant: WorkerGrant }
  | { kind: 'input'; input: MediaInput }

// A subtitle file shipped next to the video. With a url it clones into the
// worker; a read function pins the job to the page like 'input' does.
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

export interface RemuxJobCallbacks {
  onProgress?: (pct: number) => void
  onHandle?: (handle: ClientRemuxHandle) => void
}

/** Thrown when the planner looked at the source and declined it. */
export class UnsupportedMediaError extends Error {
  constructor() {
    super('unsupported media')
    this.name = 'UnsupportedMediaError'
  }
}

/**
 * The planner could not even read the source. What that means depends on
 * the source's kind — an unreadable picked file, an unreachable url — so
 * the raw failure rides along for the caller to name.
 */
export class PlanFailedError extends Error {
  failure: unknown
  constructor(failure: unknown) {
    super('plan failed')
    this.name = 'PlanFailedError'
    this.failure = failure
  }
}

export function sourceSize(source: RemuxSource): number {
  return source.kind === 'file' ? source.file.size
    : source.kind === 'input' ? source.input.size
    : source.kind === 'worker' ? source.grant.size
    : source.size
}

/** Whether the job is plain data end to end and may cross into a worker. */
export function jobIsCloneable(job: RemuxJob): boolean {
  return job.source.kind !== 'input' && job.sideFiles.every((file) => file.url !== undefined)
}

// 'worker' is a torrent file on the fleet, 'stream' any plain Range origin
// (the dev fixture), 'url' a plugin's own server. All are bytes behind
// Range requests, read the same resilient way; only the error they turn
// into differs.
function buildInput(source: RemuxSource, roomID: string): MediaInput {
  switch (source.kind) {
    case 'file': return fileInput(source.file)
    case 'stream': return rangeInput(source.url, source.name, source.size)
    case 'url': return rangeInput(source.url, source.name, source.size)
    case 'worker': return workerInput(source.grant, roomID)
    case 'input': return source.input
  }
}

/**
 * Runs the whole preparo and resolves when the remux completes. Errors are
 * thrown raw — the caller classifies them, because the page and the worker
 * report them through different seams.
 */
export async function runRemuxJob(job: RemuxJob, { onProgress, onHandle }: RemuxJobCallbacks): Promise<void> {
  const input = buildInput(job.source, job.roomID)
  let plan: Awaited<ReturnType<typeof planClientRemux>>
  try {
    plan = await planClientRemux(input)
  } catch (error) {
    throw new PlanFailedError(error)
  }
  if (!plan) throw new UnsupportedMediaError()

  // Subtitles run beside the remux, off the same bytes, and publish as they
  // go; the room has them before the video finishes.
  const subtitles = publishSubtitles(input, job.sideFiles, job.roomID, job.mediaGeneration)
  try {
    await runClientRemux({
      roomID: job.roomID,
      mediaGeneration: job.mediaGeneration,
      file: input,
      plan,
      onProgress,
      onHandle,
    })
  } catch (error) {
    // A failed run takes the subtitle scan down with it: the room is not
    // getting this source, so nothing should keep asking the origin for it.
    input.dispose()
    throw error
  }
  // The job owns the input; it goes away once the scan is through too.
  void subtitles.finally(() => input.dispose())
}

// Subtitles arrive from two places: muxed into the video, found by a
// sequential pass, and as sibling files in the torrent, read whole. Both
// publish as they arrive, and the collector holds the final "complete" until
// every registered source has delivered.
async function publishSubtitles(
  input: MediaInput,
  sideFiles: RemuxSideFile[],
  roomID: string,
  mediaGeneration: number,
): Promise<void> {
  const collector = createSubtitleCollector(roomID, mediaGeneration)
  const external = sideFiles.slice(0, MAX_EXTERNAL_SUBTITLES)
  const embedded = isMatroska(input)
  if (external.length > 0) collector.register('external')
  if (embedded) collector.register('embedded')
  if (external.length === 0 && !embedded) return
  await Promise.all([
    external.length > 0 ? loadExternalSubtitles(external, collector) : Promise.resolve(),
    embedded ? extractEmbeddedSubtitles(input, collector) : Promise.resolve(),
  ])
}

// The scan reads the whole file, at scan priority so it trails the remux
// in the swarm. A seek aborts whatever read it was on; the scan simply asks
// for the same slice again, however many seeks it takes — its position has
// nothing to do with the seek. Only the input closing for good ends it.
async function extractEmbeddedSubtitles(input: MediaInput, collector: SubtitleCollector): Promise<void> {
  try {
    const stream = await createMatroskaSubtitleStream()
    let lastSnapshotAt = Date.now()
    for (let offset = 0; offset < input.size; offset += SUBTITLE_SLICE_BYTES) {
      const end = Math.min(offset + SUBTITLE_SLICE_BYTES, input.size)
      let slice: Uint8Array
      try {
        slice = await input.read(offset, end, { prio: 'scan' })
      } catch (error) {
        if (!(error instanceof ReadAbortedError) || error.closed) throw error
        offset -= SUBTITLE_SLICE_BYTES
        await new Promise((resolve) => setTimeout(resolve, 250))
        continue
      }
      stream.write(slice)
      if (Date.now() - lastSnapshotAt >= SUBTITLE_SNAPSHOT_MS) {
        lastSnapshotAt = Date.now()
        collector.publish('embedded', stream.snapshot(), false)
      }
    }
    collector.publish('embedded', await stream.finish(), true)
  } catch (error) {
    console.error('subtitle extraction failed', error)
    collector.publish('embedded', [], true)
  }
  await collector.flush()
}

async function readSideFile(file: RemuxSideFile): Promise<ArrayBuffer> {
  if (file.read) return await file.read()
  const response = await fetch(file.url ?? '')
  if (!response.ok && response.status !== 206) throw new Error(`side file read failed (${response.status})`)
  return await response.arrayBuffer()
}

async function loadExternalSubtitles(files: RemuxSideFile[], collector: SubtitleCollector): Promise<void> {
  const tracks: VttTrack[] = []
  for (const file of files) {
    try {
      const track = convertSubtitleFile(file.path, await readSideFile(file))
      if (!track) continue
      tracks.push(track)
      collector.publish('external', [...tracks], false)
    } catch (error) {
      console.warn('external subtitle unavailable', file.path, error)
    }
  }
  collector.publish('external', tracks, true)
  await collector.flush()
}
