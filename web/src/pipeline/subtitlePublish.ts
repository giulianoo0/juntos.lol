/**
 * Subtitles for a room, from wherever they come: muxed into the video and
 * found by a sequential pass, or sibling files read whole. Both publish as
 * they arrive; the collector holds "complete" until every source delivered.
 * Reads go through a plain byte reader so the fleet's subtitle scan never
 * loads the remuxer.
 */
import {
  createMatroskaSubtitleStream,
  createSubtitleCollector,
  isMatroska,
  postSubtitleFonts,
  type SubtitleCollector,
} from '../subtitles'
import { convertSubtitleFile, type VttTrack } from '../subtitleFormats'
import type { ByteTap } from './byteTap'
import { ReadAbortedError } from './rangeRead'
import type { ReadHint } from './mediaInput'

const MAX_EXTERNAL_SUBTITLES = 16
const SUBTITLE_SNAPSHOT_MS = 8_000
const SUBTITLE_SLICE_BYTES = 8 * 1024 * 1024
const SCAN_HOLDOFF_MAX_MS = 45_000
const SCAN_PATIENCE_MS = 60_000

export interface SubtitleSource {
  name: string
  size: number
  type?: string
  read(start: number, end: number, hint?: ReadHint): Promise<Uint8Array>
  tap?: ByteTap
  /** Whether the origin is busy producing a fresh region, and for how long. */
  cold?(): { cold: boolean; forMs: number }
  sidecarUrl?(index: number): string
}

export interface SubtitleSideFile {
  name: string
  path: string
  size: number
  url?: string
  index?: number
  read?: () => Promise<ArrayBuffer>
}

/** `solo` walks the source on its own reads; otherwise the scan rides the
 * remux's byte tap and only reads for itself when the tap runs dry. */
export async function publishSubtitles(
  input: SubtitleSource,
  sideFiles: SubtitleSideFile[],
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

async function extractEmbeddedSubtitles(input: SubtitleSource, collector: SubtitleCollector,
  roomID: string, mediaGeneration: number, solo: boolean): Promise<void> {
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
        const { cold, forMs } = input.cold?.() ?? { cold: false, forMs: 0 }
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

async function readSideFile(file: SubtitleSideFile, input: SubtitleSource): Promise<ArrayBuffer> {
  if (file.read) return await file.read()
  const url = file.index !== undefined && input.sidecarUrl ? input.sidecarUrl(file.index) : file.url ?? ''
  const response = await fetch(url)
  if (!response.ok && response.status !== 206) throw new Error(`side file read failed (${response.status})`)
  return await response.arrayBuffer()
}

async function loadExternalSubtitles(files: SubtitleSideFile[], collector: SubtitleCollector, input: SubtitleSource): Promise<void> {
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
