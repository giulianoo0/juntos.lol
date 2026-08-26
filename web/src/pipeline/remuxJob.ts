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
import { fileInput, rangeInput, torrentInput, workerInput, type MediaInput } from './mediaInput'
// Re-exported so every existing import site keeps working; the declarations
// themselves live in a leaf module the page can load without the remuxer.
export * from './remuxTypes'
import type { RemuxJob, RemuxSideFile, RemuxSource } from './remuxTypes'
import { ReadAbortedError } from './rangeRead'
import { lastPlanRefusal, planClientRemux, runClientRemux, type ClientRemuxHandle } from './clientMedia'

// Headroom under the server's per-room track cap for the tracks muxed into
// the video itself.
const MAX_EXTERNAL_SUBTITLES = 16
// How often the cues seen so far are republished while bytes keep arriving.
const SUBTITLE_SNAPSHOT_MS = 8_000
// The slice a subtitle pass reads at a time. Big enough that a torrent read
// is worth the round trip, small enough to keep memory flat on a 50 GB file.
const SUBTITLE_SLICE_BYTES = 8 * 1024 * 1024

export interface RemuxJobCallbacks {
  onProgress?: (pct: number) => void
  onHandle?: (handle: ClientRemuxHandle) => void
}

/** Thrown when the planner looked at the source and declined it. */
export class UnsupportedMediaError extends Error {
  /** What the planner objected to, in words, for a report to carry. */
  readonly reason: string | null
  constructor(reason: string | null = null) {
    super(reason ? `unsupported media: ${reason}` : 'unsupported media')
    this.name = 'UnsupportedMediaError'
    this.reason = reason
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
    case 'torrentFile': return torrentInput(source.file)
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
  if (!plan) throw new UnsupportedMediaError(lastPlanRefusal())

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
  // Nothing is going to walk this file, so nothing should be mirrored for it:
  // an open tap with no reader fills its budget with copies of bytes it will
  // never hand over, and holds them for the whole job.
  if (!embedded) input.tap?.close()
  if (external.length === 0 && !embedded) return
  await Promise.all([
    external.length > 0 ? loadExternalSubtitles(external, collector, input) : Promise.resolve(),
    embedded ? extractEmbeddedSubtitles(input, collector) : Promise.resolve(),
  ])
}

// The scan walks the file from end to end, but it rides the remux's reads
// wherever it can: those bytes are already crossing the wire, and on a
// remote worker a second cursor would open a second piece window competing
// for the same swarm. Only what the remux skipped — the gap a seek leaves —
// is asked for, at scan priority, so the parser always sees one contiguous
// stream. A seek aborts whatever read it was on; the scan simply asks for
// the same slice again, however many seeks it takes — its position has
// nothing to do with the seek. Only the input closing for good ends it.
async function extractEmbeddedSubtitles(input: MediaInput, collector: SubtitleCollector): Promise<void> {
  try {
    const stream = await createMatroskaSubtitleStream()
    const tap = input.tap
    let lastSnapshotAt = Date.now()
    let offset = 0
    while (offset < input.size) {
      let slice = tap ? await tap.pull() : null
      if (!slice) {
        const end = Math.min(offset + SUBTITLE_SLICE_BYTES, input.size)
        try {
          slice = await input.read(offset, end, { prio: 'scan' })
        } catch (error) {
          if (!(error instanceof ReadAbortedError) || error.closed) throw error
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
        // The tap's cursor is this loop's cursor: a slice fetched here is
        // one the remux must not hand over again.
        tap?.fill(slice)
      }
      if (slice.length === 0) break
      offset += slice.length
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
  } finally {
    // Whether it finished or died on its first await — the parser bundle is
    // fetched over the network — the mirror has no reader from here on.
    input.tap?.close()
  }
  await collector.flush()
}

async function readSideFile(file: RemuxSideFile, input: MediaInput): Promise<ArrayBuffer> {
  if (file.read) return await file.read()
  const url = file.workerIndex !== undefined && input.sidecarUrl ? input.sidecarUrl(file.workerIndex) : file.url ?? ''
  const response = await fetch(url)
  if (!response.ok && response.status !== 206) throw new Error(`side file read failed (${response.status})`)
  return await response.arrayBuffer()
}

async function loadExternalSubtitles(files: RemuxSideFile[], collector: SubtitleCollector, input: MediaInput): Promise<void> {
  const tracks: VttTrack[] = []
  for (const file of files) {
    try {
      const track = convertSubtitleFile(file.path, await readSideFile(file, input))
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
