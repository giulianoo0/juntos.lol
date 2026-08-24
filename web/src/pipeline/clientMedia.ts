/**
 * The client media pipeline: this browser remuxes the source itself and PUTs
 * segments straight into the bucket through URLs the server signs, so the
 * VPS never spends a byte of disk or a second of ffmpeg on the room.
 *
 * The shape mirrors the server pipeline it replaces: video is copied (the
 * copyable set and the server's are the same four codecs), audio is
 * transcoded to AAC, output is CMAF/HLS in 4-second segments. The server
 * stays the only authority on what gets published — every uploaded segment
 * is confirmed against the bucket before any playlist may name it.
 *
 * This is the only pipeline. A source this browser cannot remux is a room
 * that cannot be opened, and the verdict is told to the host — there is no
 * server to hand the file to.
 */
import {
  ALL_FORMATS,
  BufferTarget,
  CmafOutputFormat,
  Conversion,
  ConversionCanceledError,
  EncodedPacketSink,
  HlsOutputFormat,
  Input,
  Output,
  PathedTarget,
  canEncodeAudio,
} from 'mediabunny'
import { registerAc3Decoder } from '@mediabunny/ac3'
import { registerDtsDecoder } from '@mediabunny/dts'
import { registerAacEncoder } from '@mediabunny/aac-encoder'
import { readMkvChapters } from './mkvChapters'
import type { MediaInput } from './mediaInput'

// The WASM decoders register lazily: nothing loads until a file actually
// carries one of these codecs.
registerAc3Decoder()
registerDtsDecoder()
registerAacEncoder()

/** The codecs the pipeline will copy — the same set the server refuses to
 * transcode away from. */
const COPYABLE_VIDEO = new Set(['avc', 'hevc', 'vp9', 'av1'])
const SEGMENT_SECONDS = 4
/** How many segments ride in one presign batch. */
const PRESIGN_BATCH = 32
/** How often accumulated segments and playlists are pushed to the server. */
const PUBLISH_INTERVAL_MS = 2_000
const PUT_RETRIES = 2
/** How many extra drain rounds a stuck object gets before the complete pass. */
const DRAIN_ROUNDS = 10

export interface ClientRemuxPlan {
  input: Input
  audioTracks: { language: string }[]
  durationSeconds: number
}

/**
 * Decides whether this browser can prepare this source itself. Null is a
 * verdict, never an error: the source is not something this browser can
 * remux, and the host is told so.
 */
export async function planClientRemux(file: MediaInput): Promise<ClientRemuxPlan | null> {
  try {
    const input = new Input({ source: file.source(), formats: ALL_FORMATS })
    if (!(await input.canRead())) return null
    const video = await input.getPrimaryVideoTrack()
    if (!video || !video.codec || !COPYABLE_VIDEO.has(video.codec)) return null
    const audioTracks = await input.getAudioTracks()
    for (const track of audioTracks) {
      // Copyable AAC skips the decoder entirely; everything else must be
      // decodable here (WebCodecs or a registered WASM decoder) and AAC must
      // be encodable, or the room would end up with silent video.
      if (track.codec === 'aac') continue
      if (!(await track.canDecode())) return null
      if (!(await canEncodeAudio('aac'))) return null
    }
    const durationSeconds = await input.computeDuration()
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null
    return {
      input,
      audioTracks: audioTracks.map((track) => ({ language: track.languageCode })),
      durationSeconds,
    }
  } catch {
    return null
  }
}

interface ClaimResponse {
  claim: string
  mediaGeneration: number
  maxBytes: number
}

interface PendingObject {
  name: string
  bytes: Uint8Array
}

export interface RunClientRemuxOptions {
  roomID: string
  mediaGeneration: number
  file: MediaInput
  plan: ClientRemuxPlan
  onProgress?: (pct: number) => void
  /** Hands out the live pipeline handle once the remux is running. */
  onHandle?: (handle: ClientRemuxHandle) => void
}

/**
 * The running pipeline, as the room page drives it: fed the room's absolute
 * position, it decides for itself whether the current region covers it or the
 * conversion has to restart there.
 */
export interface ClientRemuxHandle {
  follow(absoluteMs: number): void
}

/** How far past the produced edge a position may run before the pipeline
 * restarts there instead of letting production catch up. */
const COLD_AHEAD_MS = 30_000
/** Positions this close before the region start are treated as covered: the
 * keyframe snap places region starts slightly before the requested time. */
const COLD_BEHIND_MS = 1_000

/**
 * Thrown when the room moved on under the run — the source was swapped, so the
 * server released the claim or rejected the generation. The caller must not
 * report it as a failure of this source: the room is on a different one now.
 */
export class RoomMovedOnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoomMovedOnError'
  }
}

/**
 * A failed call to one of the client-media endpoints, carrying the server's
 * own `error` code from the JSON body. The code — not the HTTP status — is
 * what distinguishes a source swap (`claim_mismatch`, `stale_generation`)
 * from a run that simply failed (`no_playable_media`) or a bucket PUT that
 * 403'd: the same status means different things, so only the code decides.
 */
class ServerError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status: number) {
    super(`client media ${code || 'error'} (${status})`)
    this.name = 'ServerError'
    this.code = code
    this.status = status
  }
}

/** The error codes the server returns when the room has moved on under a run. */
const MOVED_ON_CODES = new Set(['claim_mismatch', 'stale_generation', 'room_not_found'])

// Reads the server's `{"error": code}` body off a failed response.
async function serverError(response: Response): Promise<ServerError> {
  let code = ''
  try {
    const body = await response.json() as { error?: string }
    code = body.error ?? ''
  } catch { /* no JSON body */ }
  return new ServerError(code, response.status)
}

/**
 * Runs the whole pipeline: claim, remux, upload, publish, complete. Throws on
 * failure — RoomMovedOnError when the room was swapped (do not fall back),
 * any other error when the run itself failed (fall back to tus). The claim is
 * released on the way out either way, so the fallback upload can proceed.
 */
export async function runClientRemux({ roomID, mediaGeneration, file, plan, onProgress, onHandle }: RunClientRemuxOptions): Promise<void> {
  const claimResponse = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/client-media/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!claimResponse.ok) throw new Error(`client media claim refused: ${claimResponse.status}`)
  const { claim, mediaGeneration: serverGeneration } = await claimResponse.json() as ClaimResponse
  if (serverGeneration !== mediaGeneration) {
    await releaseClaim(roomID, claim)
    throw new RoomMovedOnError('client media claim raced a source swap')
  }

  try {
    await remuxAndPublish({ roomID, mediaGeneration, file, plan, claim, onProgress, onHandle })
  } catch (error) {
    // The server releases the claim itself on a successful complete; this
    // covers every path that threw before it, so a retry from the host does
    // not hit a still-held reservation.
    await releaseClaimReliably(roomID, claim)
    // Only the server's own swap codes mean the room moved on. Everything
    // else — a bucket 403, a 409 no_playable_media, a network error — is a
    // failed run.
    if (error instanceof ServerError && MOVED_ON_CODES.has(error.code)) {
      throw new RoomMovedOnError(error.message)
    }
    throw error
  }
}

async function releaseClaim(roomID: string, claim: string): Promise<void> {
  await fetch(`/api/rooms/${encodeURIComponent(roomID)}/client-media?claim=${encodeURIComponent(claim)}`, {
    method: 'DELETE',
  })
}

// Releasing must actually land, or the next attempt on this room hits a
// still-held reservation and wedges it until its TTL. A 404 or 403 means the claim
// is already gone (room swapped, or the server released it on complete), which
// is success for our purpose; only a network error or 5xx is retried.
async function releaseClaimReliably(roomID: string, claim: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/client-media?claim=${encodeURIComponent(claim)}`, {
        method: 'DELETE',
      })
      if (response.ok || response.status === 404 || response.status === 403) return
    } catch {
      // network error — retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
  }
}

async function remuxAndPublish({ roomID, mediaGeneration, file, plan, claim, onProgress, onHandle }: RunClientRemuxOptions & { claim: string }): Promise<void> {
  // Object flow: the muxer hands finished files to `pending`; `pump` drains
  // them through presign + PUT into `uploaded`; each publish confirms
  // `uploaded` names with the server, which HEADs the bucket and extends the
  // published set the playlists are cut against.
  // The chapters ride the first publish; mediabunny does not read them, so
  // a small EBML pass over the file's head does.
  const chaptersOnce = readMkvChapters(file)
  const totalBytes = file.size
  const pending: PendingObject[] = []
  const uploaded: string[] = []
  const playlists = new Map<string, string>()
  let uploadedBytes = 0
  let failure: unknown = null
  let metadataSent = false

  const fail = (error: unknown) => {
    // The first failure aborts everything: the conversion stops encoding, the
    // ticker stops publishing, and execute() throws — instead of paying to
    // upload the rest of a doomed run.
    failure ??= error
    void conversion?.cancel().catch(() => {})
  }

  // Backpressure: the muxer must not outrun the uplink. enqueue awaits a slot,
  // so `pending` never holds more than a few segments' worth of bytes even on
  // a huge file over a slow connection — the OOM the 50 GB ceiling would
  // otherwise invite.
  const inflight = new Set<Promise<void>>()
  const enqueue = async (name: string, target: unknown): Promise<void> => {
    if (failure) return
    const buffer = (target as BufferTarget).buffer
    if (!buffer) { fail(new Error(`segment ${name} finished without bytes`)); return }
    pending.push({ name, bytes: new Uint8Array(buffer) })
    while (inflight.size >= PRESIGN_BATCH) await Promise.race(inflight)
    const task = pump().catch(fail)
    inflight.add(task)
    void task.finally(() => inflight.delete(task))
    if (pending.length >= PRESIGN_BATCH) await Promise.race(inflight)
  }

  const pump = async () => {
    const batch = pending.splice(0, PRESIGN_BATCH)
    if (batch.length === 0) return
    const presign = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/client-media/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claim,
        objects: batch.map((object) => ({ name: object.name, size: object.bytes.byteLength })),
      }),
    })
    if (!presign.ok) throw await serverError(presign)
    const { objects } = await presign.json() as { objects: { name: string; url: string; headers: Record<string, string> }[] }
    const byName = new Map(objects.map((object) => [object.name, object]))
    await Promise.all(batch.map(async (object) => {
      const signed = byName.get(object.name)
      if (!signed) throw new Error(`presign missing ${object.name}`)
      await putWithRetry(signed.url, signed.headers, object.bytes)
      uploaded.push(object.name)
      uploadedBytes += object.bytes.byteLength
    }))
  }

  // Returns whether the server considers the room playable, which is the
  // only trustworthy "done" signal on the complete pass.
  const publish = async (complete: boolean): Promise<boolean> => {
    const confirm = uploaded.splice(0, 128)
    const body: Record<string, unknown> = {
      claim,
      mediaGeneration,
      confirm,
      playlists: Object.fromEntries(playlists),
      complete,
      progress: { receivedBytes: uploadedBytes, sourceBytes: totalBytes },
      // The offset is read at send time: after a seek it names the new
      // region, and the server holds it back until that region's master
      // actually renders.
      timeline: { durationMs: Math.round(plan.durationSeconds * 1000), offsetMs: regionStartMs },
    }
    const chapters = metadataSent ? [] : await chaptersOnce
    if (!metadataSent) {
      body.audioTracks = plan.audioTracks.map((track) => ({ language: track.language, title: '' }))
      if (chapters.length > 0) body.chapters = chapters
    }
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/client-media/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw await serverError(response)
    // The metadata stuck only now that the request succeeded.
    metadataSent = true
    const { confirmed, ready } = await response.json() as { confirmed: string[]; ready: boolean }
    // Whatever the bucket did not vouch for is claimed again next round.
    const vouched = new Set(confirmed)
    for (const name of confirm) if (!vouched.has(name)) uploaded.push(name)
    return ready
  }

  // One region at a time: a contiguous stretch of the source, converted in
  // order from wherever the room last landed. The upload machinery above is
  // shared across regions — segments of an abandoned region finish uploading
  // harmlessly, since a region's names are never reused.
  let conversion: Conversion | null = null
  let region = -1
  let regionStartMs = 0
  let segmentsEmitted = 0
  let seekTargetSeconds: number | null = null
  let nextStartSeconds = 0

  // Seeks snap back to the keyframe at or before the target, so a region
  // always starts on a frame the copied stream can actually begin at.
  const videoTrack = await plan.input.getPrimaryVideoTrack()
  const packetSink = videoTrack ? new EncodedPacketSink(videoTrack) : null
  const snapToKeyframe = async (seconds: number): Promise<number> => {
    try {
      const key = await packetSink?.getKeyPacket(seconds, { verifyKeyPackets: true })
      return key ? key.timestamp : seconds
    } catch {
      return seconds
    }
  }

  // Publishing runs alongside the remux for the same reason the server's
  // does: a room that only became watchable at the end would not be a
  // preview. A publish failure aborts the whole run through fail().
  let publishing = false
  const ticker = setInterval(() => {
    if (publishing || failure) return
    publishing = true
    void publish(false).catch(fail).finally(() => { publishing = false })
  }, PUBLISH_INTERVAL_MS)

  let restartPending = false
  let lastFollowMs: number | null = null
  const uncovered = (absoluteMs: number): boolean => {
    const producedEndMs = regionStartMs + segmentsEmitted * SEGMENT_SECONDS * 1000
    return absoluteMs < regionStartMs - COLD_BEHIND_MS
      || absoluteMs > producedEndMs + COLD_AHEAD_MS
  }
  const restartAt = (absoluteMs: number) => {
    restartPending = true
    void (async () => {
      seekTargetSeconds = await snapToKeyframe(absoluteMs / 1000)
      await conversion?.cancel().catch(() => {})
    })()
  }
  const handle: ClientRemuxHandle = {
    follow: (absoluteMs) => {
      // Remembered even mid-restart: a second seek while the first is still
      // tearing down must win, and the new region rechecks it on arrival.
      lastFollowMs = absoluteMs
      if (failure || restartPending) return
      if (uncovered(absoluteMs)) restartAt(absoluteMs)
    },
  }

  try {
  while (true) {
    region += 1
    const startSeconds = nextStartSeconds
    regionStartMs = Math.round(startSeconds * 1000)
    segmentsEmitted = 0
    seekTargetSeconds = null
    // The old region's playlists stay published on the server; only the
    // local map restarts, so the next publish carries the new region's
    // master rather than a mix.
    playlists.clear()
    // Region zero keeps the unprefixed names existing rooms already use.
    const prefix = region === 0 ? '' : `r${region}_`

    const output = new Output({
      format: new HlsOutputFormat({
        segmentFormat: new CmafOutputFormat(),
        targetDuration: SEGMENT_SECONDS,
        live: true,
        getPlaylistPath: ({ n }) => `${prefix}client_stream_${n}.m3u8`,
        getSegmentPath: ({ playlist, n }) => `${prefix}cs_${playlist.n}_${n}.m4s`,
        getInitPath: ({ n }) => `${prefix}cinit_${n}.mp4`,
        onMaster: (content) => { playlists.set('master.m3u8', content) },
        onPlaylist: (content, info) => { playlists.set(`${prefix}client_stream_${info.n}.m3u8`, content) },
        onInit: (target, info) => { enqueue(`${prefix}cinit_${info.n}.mp4`, target) },
        onSegment: (target, info) => {
          segmentsEmitted += 1
          enqueue(`${prefix}cs_${info.playlist.n}_${info.n}.m4s`, target)
        },
      }),
      target: new PathedTarget('master.m3u8', () => new BufferTarget()),
    })

    const current = await Conversion.init({
      input: plan.input,
      output,
      audio: { codec: 'aac' },
      ...(startSeconds > 0 ? { trim: { start: startSeconds } } : {}),
    })
    if (!current.isValid) {
      throw new Error('client remux plan rejected by conversion: '
        + current.discardedTracks.map((track) => track.reason).join(', '))
    }
    // Progress is the whole timeline's, not the region's: the bar must not
    // jump back to zero because someone sought.
    current.onProgress = (progress) => {
      const regionSpan = Math.max(plan.durationSeconds - startSeconds, 0)
      onProgress?.(Math.round(((startSeconds + progress * regionSpan) / plan.durationSeconds) * 100))
    }
    conversion = current
    restartPending = false
    if (region === 0) onHandle?.(handle)
    // A seek that arrived while this region was being set up may point
    // somewhere else entirely; honour it before paying for any conversion.
    if (lastFollowMs !== null && uncovered(lastFollowMs)) restartAt(lastFollowMs)

    try {
      await current.execute()
    } catch (error) {
      // A cancel is either a seek (restart there) or fail() (throw below);
      // anything else is the conversion's own failure.
      if (!(error instanceof ConversionCanceledError)) fail(error)
    }
    if (failure) throw failure
    if (seekTargetSeconds !== null) {
      nextStartSeconds = seekTargetSeconds
      continue
    }
    break
  }

  await Promise.all([...inflight])
  if (failure) throw failure
  } finally {
    clearInterval(ticker)
  }
  // Drain what the remux produced, bounded: an object the bucket never
  // vouches for must not spin here forever short of the complete pass.
  for (let round = 0; uploaded.length > 0 && round < DRAIN_ROUNDS; round += 1) await publish(false)
  // The complete pass throws (409 no_playable_media) if it produced nothing
  // watchable.
  await publish(true)
}

async function putWithRetry(url: string, headers: Record<string, string>, bytes: Uint8Array): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= PUT_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'PUT', headers, body: bytes as unknown as BodyInit })
      if (response.ok) return
      lastError = new Error(`segment PUT failed: ${response.status}`)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
