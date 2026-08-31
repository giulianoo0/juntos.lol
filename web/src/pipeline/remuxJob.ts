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
  postSubtitleFonts,
  type SubtitleCollector,
} from '../subtitles'
import { convertSubtitleFile, type VttTrack } from '../subtitleFormats'
import { fileInput, rangeInput, torrentInput, workerInput, type MediaInput } from './mediaInput'
// Re-exported so every existing import site keeps working; the declarations
// themselves live in a leaf module the page can load without the remuxer.
export * from './remuxTypes'
import type { RemuxJob, RemuxSideFile, RemuxSource } from './remuxTypes'
import { ReadAbortedError } from './rangeRead'
import type { SeekTrace } from './seekTrace'
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
  onTrace?: (trace: SeekTrace) => void
}

// The longest the subtitle scan waits after a seek for the region to warm
// before it asks the origin for its own bytes again. A torrent's swarm
// gives every open stream its own window: while the remux is fetching the
// first pieces of a fresh region, a scan slice of 8 MiB competes with them.
// The scan's position has nothing to do with the seek; it waits until the
// new region's first segment is in the bucket, and this long at the most,
// so a region that never warms cannot starve it forever.
const SCAN_HOLDOFF_MAX_MS = 45_000
// How long the scan keeps waiting for bytes the remux is about to read past
// its cursor before fetching them itself. The remux is slow exactly when the
// swarm is — and a second cursor on the same stretch is what it least needs
// then — so the wait is generous; the cap only guards a remux that stopped.
const SCAN_PATIENCE_MS = 60_000

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
export async function runRemuxJob(job: RemuxJob, { onProgress, onHandle, onTrace }: RemuxJobCallbacks): Promise<void> {
  const input = coldAware(buildInput(job.source, job.roomID))
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
      onTrace,
      onRegionWarm: input.warm,
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

/**
 * Walks the source for subtitles and fonts, publishing as it goes, without
 * producing any media: the room's video comes from the fleet's own FFmpeg,
 * which does not extract subtitles. The scan owns the origin, so it never
 * waits on a remux that is not here.
 */
export async function runSubtitleJob(job: RemuxJob): Promise<void> {
  const input = coldAware(buildInput(job.source, job.roomID))
  input.warm()
  input.tap?.close()
  try {
    await publishSubtitles(input, job.sideFiles, job.roomID, job.mediaGeneration, true)
  } finally {
    input.dispose()
  }
}

/** An input that knows whether the origin is busy with a fresh region. */
interface ColdAwareInput extends MediaInput {
  /** Whether the region being produced has nothing in the bucket yet — a
   * seek just happened, or the job just began, which is the same to the
   * origin — and for how long that has been so. */
  cold(): { cold: boolean; forMs: number }
  /** The region's first segment landed: the origin has room for others. */
  warm(): void
}

function coldAware(input: MediaInput): ColdAwareInput {
  let coldSince: number | null = Date.now()
  const abortReads = input.abortReads.bind(input)
  return Object.assign(input, {
    abortReads: () => { coldSince = Date.now(); abortReads() },
    cold: () => ({ cold: coldSince !== null, forMs: coldSince === null ? 0 : Date.now() - coldSince }),
    warm: () => { coldSince = null },
  })
}

// Subtitles arrive from two places: muxed into the video, found by a
// sequential pass, and as sibling files in the torrent, read whole. Both
// publish as they arrive, and the collector holds the final "complete" until
// every registered source has delivered.
async function publishSubtitles(
  input: ColdAwareInput,
  sideFiles: RemuxSideFile[],
  roomID: string,
  mediaGeneration: number,
  solo = false,
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
    embedded ? extractEmbeddedSubtitles(input, collector, roomID, mediaGeneration, solo) : Promise.resolve(),
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
async function extractEmbeddedSubtitles(input: ColdAwareInput, collector: SubtitleCollector,
  roomID: string, mediaGeneration: number, solo = false): Promise<void> {
  // Fonts the container attached for its ASS tracks, sent as they are seen.
  const sentFonts = new Set<string>()
  try {
    const stream = await createMatroskaSubtitleStream()
    const tap = input.tap
    let lastSnapshotAt = Date.now()
    let published = false
    let lastProgressAt = Date.now()
    let offset = 0
    // With the scan alone on the origin (the fleet produces the media), the
    // next slice is fetched while this one parses: the wire never sits idle
    // between round trips, which is what made subtitles crawl.
    let ahead: { at: number; read: Promise<Uint8Array> } | null = null
    const readAt = (at: number): Promise<Uint8Array> =>
      input.read(at, Math.min(at + SUBTITLE_SLICE_BYTES, input.size), { prio: 'scan' })
    while (offset < input.size) {
      let slice: Uint8Array | null = null
      if (solo) {
        try {
          slice = ahead && ahead.at === offset ? await ahead.read : await readAt(offset)
        } catch (error) {
          ahead = null
          if (!(error instanceof ReadAbortedError) || error.closed) throw error
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
        ahead = null
        const nextAt: number = offset + slice.length
        if (slice.length > 0 && nextAt < input.size) {
          const read = readAt(nextAt)
          // The loop may end (error, close) before this is awaited.
          read.catch(() => undefined)
          ahead = { at: nextAt, read }
        }
      } else {
        slice = tap ? await tap.pull() : null
      }
      if (!slice && !solo) {
        // Nothing to ride: the remux is elsewhere. While that elsewhere is a
        // region with nothing published yet, it is the only thing that
        // matters, and the scan waits before asking the origin for its own.
        const { cold, forMs } = input.cold()
        if (tap && cold && forMs < SCAN_HOLDOFF_MAX_MS) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          continue
        }
        // The remux is reading right here, only slowly: what it gets next is
        // what the scan wants next. Fetching it separately would cost the
        // origin the same bytes twice, and on a swarm, a second cursor on
        // the stretch the reader is blocked on.
        if (tap?.riding && Date.now() - lastProgressAt < SCAN_PATIENCE_MS) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
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
      if (!slice) continue
      if (slice.length === 0) break
      offset += slice.length
      lastProgressAt = Date.now()
      stream.write(slice)
      // The first tracks show up fast — a viewer opening the menu on an empty
      // list reads it as broken — and after that the usual cadence holds.
      if (Date.now() - lastSnapshotAt >= (published ? SUBTITLE_SNAPSHOT_MS : 2_000)) {
        lastSnapshotAt = Date.now()
        published = true
        collector.publish('embedded', stream.snapshot(), false)
        void postSubtitleFonts(roomID, mediaGeneration, stream.fonts(), sentFonts)
      }
    }
    const finalTracks = await stream.finish()
    await postSubtitleFonts(roomID, mediaGeneration, stream.fonts(), sentFonts)
    collector.publish('embedded', finalTracks, true)
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
