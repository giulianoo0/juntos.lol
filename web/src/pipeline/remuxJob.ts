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
export * from './remuxTypes'
import type { RemuxJob, RemuxSideFile, RemuxSource } from './remuxTypes'
import { ReadAbortedError } from './rangeRead'
import type { SeekTrace } from './seekTrace'
import { lastPlanRefusal, planClientRemux, runClientRemux, type ClientRemuxHandle } from './clientMedia'

const MAX_EXTERNAL_SUBTITLES = 16
const SUBTITLE_SNAPSHOT_MS = 8_000
const SUBTITLE_SLICE_BYTES = 8 * 1024 * 1024

export interface RemuxJobCallbacks {
  onProgress?: (pct: number) => void
  onHandle?: (handle: ClientRemuxHandle) => void
  onTrace?: (trace: SeekTrace) => void
}

const SCAN_HOLDOFF_MAX_MS = 45_000
const SCAN_PATIENCE_MS = 60_000

export class UnsupportedMediaError extends Error {
  readonly reason: string | null
  constructor(reason: string | null = null) {
    super(reason ? `unsupported media: ${reason}` : 'unsupported media')
    this.name = 'UnsupportedMediaError'
    this.reason = reason
  }
}

export class PlanFailedError extends Error {
  failure: unknown
  constructor(failure: unknown) {
    super('plan failed')
    this.name = 'PlanFailedError'
    this.failure = failure
  }
}

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

/** Runs the whole preparo and resolves when the remux completes. Errors are
 * thrown raw — the caller classifies them. */
export async function runRemuxJob(job: RemuxJob, { onProgress, onHandle, onTrace }: RemuxJobCallbacks): Promise<void> {
  const input = coldAware(buildInput(job.source, job.roomID))
  let plan: Awaited<ReturnType<typeof planClientRemux>>
  try {
    plan = await planClientRemux(input)
  } catch (error) {
    throw new PlanFailedError(error)
  }
  if (!plan) throw new UnsupportedMediaError(lastPlanRefusal())

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
    input.dispose()
    throw error
  }
  void subtitles.finally(() => input.dispose())
}

/** Walks the source for subtitles and fonts, publishing as it goes, without
 * producing any media: the room's video comes from the fleet's own FFmpeg. */
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
  /** Whether the region being produced has nothing in the bucket yet, and for
   * how long that has been so. */
  cold(): { cold: boolean; forMs: number }
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
  if (!embedded) input.tap?.close()
  if (external.length === 0 && !embedded) return
  await Promise.all([
    external.length > 0 ? loadExternalSubtitles(external, collector, input) : Promise.resolve(),
    embedded ? extractEmbeddedSubtitles(input, collector, roomID, mediaGeneration, solo) : Promise.resolve(),
  ])
}

async function extractEmbeddedSubtitles(input: ColdAwareInput, collector: SubtitleCollector,
  roomID: string, mediaGeneration: number, solo = false): Promise<void> {
  const sentFonts = new Set<string>()
  try {
    const stream = await createMatroskaSubtitleStream()
    const tap = input.tap
    let lastSnapshotAt = Date.now()
    let published = false
    let lastProgressAt = Date.now()
    let offset = 0
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
          read.catch(() => undefined)
          ahead = { at: nextAt, read }
        }
      } else {
        slice = tap ? await tap.pull() : null
      }
      if (!slice && !solo) {
        const { cold, forMs } = input.cold()
        if (tap && cold && forMs < SCAN_HOLDOFF_MAX_MS) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          continue
        }
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
        tap?.fill(slice)
      }
      if (!slice) continue
      if (slice.length === 0) break
      offset += slice.length
      lastProgressAt = Date.now()
      stream.write(slice)
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
