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
import { readMkvChapters, type MkvChapter } from './mkvChapters'
import type { MediaInput } from './mediaInput'
import { postJson } from './postJson'
import { ReadAbortedError, ReadFailedError, ReadUnreachableError } from './rangeRead'
import { createSegmentLedger } from './segmentLedger'
import { createSeekTracer, formatSeekTrace, type SeekTrace } from './seekTrace'
import { isUnreadableFile } from '../uploadErrors'

registerAc3Decoder()
registerDtsDecoder()
let codecsReady: Promise<void> | null = null
function ensureCodecs(): Promise<void> {
  codecsReady ??= (async () => {
    const native = typeof AudioEncoder !== 'undefined'
      && await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000 })
        .then((support) => support.supported === true)
        .catch(() => false)
    if (!native) registerAacEncoder()
  })()
  return codecsReady
}

const COPYABLE_VIDEO = new Set(['avc', 'hevc', 'vp9', 'av1'])
const SEGMENT_SECONDS = 4
const PRESIGN_BATCH = 32
const PUT_CONCURRENCY = 8
const MAX_QUEUED_BYTES = 192 * 1024 * 1024
const PUBLISH_INTERVAL_MS = 2_000
const PUBLISH_DEBOUNCE_MS = 200
const PUT_RETRIES = 2
const DRAIN_ROUNDS = 10
const KEYFRAME_SNAP_MS = 60_000

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
  const refuse = (why: string): null => {
    lastRefusal = why
    return null
  }
  try {
    await ensureCodecs()
    const input = new Input({ source: file.source(), formats: ALL_FORMATS })
    if (!(await input.canRead())) return refuse('the container could not be read at all')
    const video = await input.getPrimaryVideoTrack()
    if (!video) return refuse('there is no video track')
    if (!video.codec) return refuse('the video track names no codec')
    if (!COPYABLE_VIDEO.has(video.codec)) {
      return refuse(`video codec ${video.codec} cannot be copied; only ${[...COPYABLE_VIDEO].join(', ')} can`)
    }
    const audioTracks = await input.getAudioTracks()
    for (const track of audioTracks) {
      if (track.codec === 'aac') continue
      if (!(await track.canDecode())) return refuse(`audio codec ${track.codec ?? 'unknown'} cannot be decoded in this browser`)
      if (!(await canEncodeAudio('aac'))) return refuse('this browser cannot encode aac, which every audio track is converted to')
    }
    const durationSeconds = await input.computeDuration()
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return refuse(`the container reports no usable duration (${durationSeconds})`)
    }
    lastRefusal = null
    return {
      input,
      audioTracks: audioTracks.map((track) => ({ language: track.languageCode })),
      durationSeconds,
    }
  } catch (error) {
    if (error instanceof ReadUnreachableError || error instanceof ReadFailedError || isUnreadableFile(error)) throw error
    return refuse(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }
}

let lastRefusal: string | null = null

export function lastPlanRefusal(): string | null {
  return lastRefusal
}

interface ClaimResponse {
  claim: string
  mediaGeneration: number
  maxBytes: number
  metadataToken?: string
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
  onTrace?: (trace: SeekTrace) => void
  onRegionWarm?: () => void
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

const COLD_AHEAD_MS = 30_000
const COLD_BEHIND_MS = 1_000

/**
 * Thrown when the room moved on under the run — the source was swapped. The
 * caller must not report it as a failure of this source.
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
 * what distinguishes a source swap from a run that simply failed.
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

const MOVED_ON_CODES = new Set(['claim_mismatch', 'stale_generation', 'room_not_found'])

async function serverError(response: Response): Promise<ServerError> {
  let code = ''
  try {
    const body = await response.json() as { error?: string }
    code = body.error ?? ''
  } catch {}
  return new ServerError(code, response.status)
}

/**
 * Runs the whole pipeline: claim, remux, upload, publish, complete. Throws
 * RoomMovedOnError when the room was swapped, any other error when the run
 * itself failed. The claim is released on the way out either way.
 */
export async function runClientRemux({ roomID, mediaGeneration, file, plan, onProgress, onHandle, onTrace, onRegionWarm }: RunClientRemuxOptions): Promise<void> {
  const claimResponse = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/client-media/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!claimResponse.ok) throw new Error(`client media claim refused: ${claimResponse.status}`)
  const { claim, mediaGeneration: serverGeneration, metadataToken } = await claimResponse.json() as ClaimResponse
  if (serverGeneration !== mediaGeneration) {
    await releaseClaim(roomID, claim)
    throw new RoomMovedOnError('client media claim raced a source swap')
  }

  try {
    await remuxAndPublish({ roomID, mediaGeneration, file, plan, claim, metadataToken, onProgress, onHandle, onTrace, onRegionWarm })
  } catch (error) {
    await releaseClaimReliably(roomID, claim)
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

async function releaseClaimReliably(roomID: string, claim: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/client-media?claim=${encodeURIComponent(claim)}`, {
        method: 'DELETE',
      })
      if (response.ok || response.status === 404 || response.status === 403) return
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
  }
}

function renditionOf(name: string): number | null {
  const match = /^(?:r\d+_)?client_stream_(\d+)\.m3u8$/.exec(name)
  return match ? Number(match[1]) : null
}

export function segmentDurations(body: string): number[] {
  const out: number[] = []
  for (const line of body.split('\n')) {
    const match = /^#EXTINF:([\d.]+)/.exec(line.trim())
    if (match) out.push(Number(match[1]))
  }
  return out
}

/**
 * The first `keep` segments of a media playlist, ended. Tags read since the
 * last segment are dropped with it. Null when there is nothing to end: a
 * playlist with no confirmed segment is an empty region, not a finished one.
 */
export function endPlaylist(body: string, keep: number): string | null {
  if (keep <= 0) return null
  const out: string[] = []
  let pending: string[] = []
  let segments = 0
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      pending.push(line)
      continue
    }
    if (segments === keep) break
    out.push(...pending, line)
    pending = []
    segments += 1
  }
  if (segments === 0) return null
  return `${out.join('\n')}\n#EXT-X-ENDLIST\n`
}

async function remuxAndPublish({ roomID, mediaGeneration, file, plan, claim, metadataToken, onProgress, onHandle, onTrace, onRegionWarm }: RunClientRemuxOptions & { claim: string; metadataToken?: string }): Promise<void> {
  void readMkvChapters(file).then(async (found: MkvChapter[]) => {
    if (found.length === 0 || !metadataToken) return
    await postMetadataWithRetry(roomID, mediaGeneration, metadataToken, found)
  }).catch(() => undefined)
  const totalBytes = file.size
  const uploaded: string[] = []
  const playlists = new Map<string, string>()
  const sealed = new Map<string, { prefix: string; region: number; playlist: number; body: string }>()
  let uploadedBytes = 0
  let failure: unknown = null
  let metadataSent = false
  const runId = crypto.randomUUID()
  let seq = 0

  const fail = (error: unknown) => {
    failure ??= error
    onFailure()
    void conversion?.cancel().catch(() => {})
  }
  let onFailure: () => void = () => {}

  const queued: PendingObject[] = []
  let queuedBytes = 0
  let activeSlots = 0
  let inflightBytes = 0
  const inflightAborts = new Set<AbortController>()
  const capacityWaiters: (() => void)[] = []
  const idleWaiters: (() => void)[] = []
  const wake = () => {
    for (const waiter of capacityWaiters.splice(0)) waiter()
    if (queued.length === 0 && activeSlots === 0 && inflightBytes === 0) {
      for (const waiter of idleWaiters.splice(0)) waiter()
    }
  }
  const waitCapacity = () => new Promise<void>((resolve) => capacityWaiters.push(resolve))
  onFailure = () => {
    for (const waiter of capacityWaiters.splice(0)) waiter()
    for (const waiter of idleWaiters.splice(0)) waiter()
  }
  const queueIdle = async () => {
    while (queued.length > 0 || activeSlots > 0 || inflightBytes > 0) {
      if (failure) return
      await new Promise<void>((resolve) => idleWaiters.push(resolve))
    }
  }
  const admit = async (name: string, buffer: ArrayBuffer | null): Promise<void> => {
    if (failure) return
    if (!buffer) { fail(new Error(`segment ${name} finished without bytes`)); return }
    while (!failure && queuedBytes + inflightBytes >= MAX_QUEUED_BYTES) await waitCapacity()
    if (failure) return
    queued.push({ name, bytes: new Uint8Array(buffer) })
    queuedBytes += buffer.byteLength
    kickPump()
  }
  const dropQueued = () => {
    for (const object of queued.splice(0)) queuedBytes -= object.bytes.byteLength
    for (const abort of inflightAborts) abort.abort()
    wake()
  }
  let pumping = false
  const kickPump = () => {
    if (pumping || failure) return
    pumping = true
    void pumpLoop().catch(fail).finally(() => {
      pumping = false
      if (queued.length > 0 && !failure) kickPump()
    })
  }
  const pumpLoop = async () => {
    while (queued.length > 0 && !failure) {
      const roomLeft = PUT_CONCURRENCY - activeSlots
      if (roomLeft <= 0) { await waitCapacity(); continue }
      const batch = queued.splice(0, Math.min(PRESIGN_BATCH, roomLeft))
      for (const object of batch) {
        queuedBytes -= object.bytes.byteLength
        inflightBytes += object.bytes.byteLength
        activeSlots += 1
      }
      void uploadBatch(batch).catch(fail)
    }
  }
  const uploadBatch = async (batch: PendingObject[]) => {
    const abort = new AbortController()
    inflightAborts.add(abort)
    const remaining = new Set(batch)
    const settle = (object: PendingObject) => {
      if (!remaining.delete(object)) return
      activeSlots -= 1
      inflightBytes -= object.bytes.byteLength
      wake()
    }
    try {
      const presign = await postJson(`/api/rooms/${encodeURIComponent(roomID)}/client-media/presign`, {
        claim,
        objects: batch.map((object) => ({ name: object.name, size: object.bytes.byteLength })),
      }, { signal: abort.signal })
      if (!presign.ok) throw await serverError(presign)
      const { objects } = await presign.json() as { objects: { name: string; url: string; headers: Record<string, string> }[] }
      const byName = new Map(objects.map((object) => [object.name, object]))
      await Promise.all(batch.map(async (object) => {
        try {
          const signed = byName.get(object.name)
          if (!signed) throw new Error(`presign missing ${object.name}`)
          await putWithRetry(signed.url, signed.headers, object.bytes, abort.signal)
        } finally {
          settle(object)
        }
        uploaded.push(object.name)
        uploadedBytes += object.bytes.byteLength
        if (inCurrentRegion(object.name)) {
          trace.mark('firstPutOk', object.name)
          kickPublish()
        }
      }))
    } catch (error) {
      if (!abort.signal.aborted) throw error
    } finally {
      for (const object of [...remaining]) settle(object)
      inflightAborts.delete(abort)
      wake()
    }
  }

  const inCurrentRegion = (name: string): boolean =>
    (region <= 0 ? !/^r\d+_/.test(name) : name.startsWith(`r${region}_`))

  let publishing: Promise<void> | null = null
  let publishDirty = false
  let publishStopped = false
  let kickTimer: ReturnType<typeof setTimeout> | null = null
  const runPublish = () => {
    if (failure || publishStopped) return
    if (publishing) { publishDirty = true; return }
    publishDirty = false
    publishing = publish(false).then(() => undefined, fail).finally(() => {
      publishing = null
      if (publishDirty) kickPublish()
    })
  }
  const kickPublish = () => {
    if (kickTimer !== null || failure || publishStopped) return
    kickTimer = setTimeout(() => { kickTimer = null; runPublish() }, PUBLISH_DEBOUNCE_MS)
  }

  const publish = async (complete: boolean): Promise<boolean> => {
    const current = inCurrentRegion
    const outstanding = (regionPrefix: string) => uploaded.some(
      (name) => (regionPrefix === '' ? !/^r\d+_/.test(name) : name.startsWith(regionPrefix)),
    )
    const sealing = [...sealed]
      .filter(([, entry]) => complete || !outstanding(entry.prefix))
      .map(([name, entry]) => [name, endPlaylist(entry.body, ledger.contiguousIn(entry.region, entry.playlist))] as const)
      .filter(([, body]) => body !== null) as [string, string][]
    uploaded.sort((a, b) => Number(current(b)) - Number(current(a)))
    const confirm = uploaded.splice(0, 128)
    const body: Record<string, unknown> = {
      claim,
      mediaGeneration,
      runId,
      seq: (seq += 1),
      confirm,
      playlists: Object.fromEntries([...sealing, ...playlists]),
      complete,
      progress: { receivedBytes: uploadedBytes, sourceBytes: totalBytes },
      timeline: { durationMs: Math.round(plan.durationSeconds * 1000), offsetMs: regionStartMs, regions: regionMap() },
    }
    if (!metadataSent) {
      body.audioTracks = plan.audioTracks.map((track) => ({ language: track.language, title: '' }))
    }
    const response = await postJson(`/api/rooms/${encodeURIComponent(roomID)}/client-media/publish`, body)
    if (!response.ok) throw await serverError(response)
    metadataSent = true
    for (const [name] of sealing) sealed.delete(name)
    const { confirmed, ready } = await response.json() as { confirmed: string[]; ready: boolean }
    ledger.noteConfirmed(confirmed)
    if (warmRegion !== region && confirmed.some((name) => /cs_\d+_\d+\.m4s$/.test(name) && current(name))) {
      warmRegion = region
      onRegionWarm?.()
    }
    if (trace.open() && region > seekFromRegion && confirmed.some((name) => /cs_\d+_\d+\.m4s$/.test(name) && current(name)) && playlists.has('master.m3u8')) {
      trace.mark('publishOk', regionSpanMs(regions.find((r) => r.growing) ?? regions[regions.length - 1]))
      trace.end()
    }
    const vouched = new Set(confirmed)
    for (const name of confirm) if (!vouched.has(name)) uploaded.push(name)
    return ready
  }

  let conversion: Conversion | null = null
  let region = -1
  let regionStartMs = 0
  interface RegionRecord { n: number; startMs: number; growing: boolean; ranToEnd: boolean }
  const regions: RegionRecord[] = []
  const ledger = createSegmentLedger()
  const trace = createSeekTracer((done) => {
    console.info(formatSeekTrace('host', done))
    onTrace?.(done)
  })
  const regionSpanMs = (r: RegionRecord): number => {
    const covered = ledger.coveredMs(r.n, SEGMENT_SECONDS * 1000)
    if (r.ranToEnd && ledger.settled(r.n)) {
      return Math.max(covered, Math.round(plan.durationSeconds * 1000) - r.startMs)
    }
    return covered
  }
  const regionMap = () => regions.map((r) => ({
    n: r.n, startMs: r.startMs, producedMs: regionSpanMs(r), growing: r.growing,
  }))
  const timelineCovered = (): boolean => {
    const durationMs = Math.round(plan.durationSeconds * 1000)
    const spans = regionMap().map((r) => ({ start: r.startMs, end: r.startMs + r.producedMs })).sort((a, b) => a.start - b.start)
    let reach = 0
    for (const span of spans) {
      if (span.start > reach + COLD_BEHIND_MS) return false
      reach = Math.max(reach, span.end)
    }
    return reach >= durationMs - SEGMENT_SECONDS * 1000
  }
  const closeRegion = () => {
    const current = regions.find((r) => r.growing)
    if (!current) return
    current.growing = false
    const stats = ledger.segmentStats(current.n)
    console.log(`[remux-worker] region ${current.n} closed: ${stats.count} segments, mean ${stats.meanSec.toFixed(2)}s, max ${stats.maxSec.toFixed(2)}s (target ${SEGMENT_SECONDS}s)`)
    const prefix = region <= 0 ? '' : `r${region}_`
    for (const [name, content] of playlists) {
      if (!content.includes('#EXTINF')) continue
      const rendition = renditionOf(name)
      if (rendition === null) continue
      sealed.set(name, { prefix, region: current.n, playlist: rendition, body: content })
      playlists.delete(name)
    }
  }
  let seekTargetSeconds: number | null = null
  let nextStartSeconds = 0
  let fillEndSeconds: number | null = null
  let seekFromRegion = -1
  let warmRegion = -1

  const videoTrack = await plan.input.getPrimaryVideoTrack()
  const packetSink = videoTrack ? new EncodedPacketSink(videoTrack) : null
  const snapToKeyframe = async (seconds: number): Promise<number> => {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), KEYFRAME_SNAP_MS) })
      const key = await Promise.race([
        packetSink?.getKeyPacket(seconds, { verifyKeyPackets: true }),
        deadline,
      ]).finally(() => clearTimeout(timer))
      return key ? Math.max(key.timestamp, 0) : Math.max(seconds, 0)
    } catch {
      return seconds
    }
  }

  const ticker = setInterval(runPublish, PUBLISH_INTERVAL_MS)

  let restartPending = false
  let pendingRestart: Promise<void> | null = null
  let draining = false
  let lastFollowMs: number | null = null
  let regionAimMs = 0
  const uncovered = (absoluteMs: number): boolean => {
    for (const r of regionMap()) {
      const end = r.startMs + r.producedMs
      const growingEdge = Math.min(Math.max(end, regionAimMs) + COLD_AHEAD_MS, fillEndSeconds !== null ? fillEndSeconds * 1000 : Number.POSITIVE_INFINITY)
      const forwardEdge = r.growing ? growingEdge : end
      if (absoluteMs >= r.startMs - COLD_BEHIND_MS && absoluteMs <= forwardEdge) return false
    }
    return true
  }
  const restartAt = (absoluteMs: number) => {
    restartPending = true
    console.log(`[remux-worker] restart at ${absoluteMs}`)
    trace.begin(absoluteMs)
    seekFromRegion = region
    closeRegion()
    pendingRestart = (async () => {
      dropQueued()
      file.abortReads()
      trace.mark('readsAborted')
      await conversion?.cancel().catch(() => {})
      console.log('[remux-worker] old region canceled')
      trace.mark('canceled')
      seekTargetSeconds = await snapToKeyframe(absoluteMs / 1000)
      console.log(`[remux-worker] snapped to ${seekTargetSeconds}`)
      trace.mark('keyframe', Math.round(seekTargetSeconds * 1000 - absoluteMs))
      regionAimMs = absoluteMs
    })()
  }
  const SETTLE_MAX_MS = 30_000
  const settled = async (n: number): Promise<void> => {
    const deadline = Date.now() + SETTLE_MAX_MS
    while (!ledger.settled(n) && !restartPending && !failure && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
    }
  }
  const nextGap = (): { startMs: number; endMs: number } | null => {
    const durationMs = Math.round(plan.durationSeconds * 1000)
    const spans = regionMap()
      .map((r) => ({ start: r.startMs, end: r.startMs + r.producedMs }))
      .sort((a, b) => a.start - b.start)
    const gaps: { startMs: number; endMs: number }[] = []
    let reach = 0
    for (const span of spans) {
      if (span.start > reach + COLD_BEHIND_MS) gaps.push({ startMs: reach, endMs: span.start })
      reach = Math.max(reach, span.end)
    }
    if (reach < durationMs - SEGMENT_SECONDS * 1000) gaps.push({ startMs: reach, endMs: durationMs })
    if (gaps.length === 0) return null
    const wanted = lastFollowMs
    const behind = wanted === null ? [] : gaps.filter((g) => g.startMs <= wanted)
    return behind.length > 0 ? behind[behind.length - 1] : gaps[0]
  }
  const handle: ClientRemuxHandle = {
    follow: (absoluteMs) => {
      lastFollowMs = absoluteMs
      if (failure || restartPending) return
      if (draining) {
        console.log(`[remux-worker] seek to ${absoluteMs} after the last region: waiting on the drain`)
        return
      }
      if (uncovered(absoluteMs)) restartAt(absoluteMs)
    },
  }

  try {
  while (true) {
    region += 1
    const startSeconds = nextStartSeconds
    regionStartMs = Math.round(startSeconds * 1000)
    regionAimMs = fillEndSeconds !== null ? regionStartMs : Math.max(regionAimMs, regionStartMs)
    closeRegion()
    seekTargetSeconds = null
    regions.push({ n: region, startMs: regionStartMs, growing: true, ranToEnd: false })
    playlists.clear()
    const prefix = region === 0 ? '' : `r${region}_`

    const output = new Output({
      format: new HlsOutputFormat({
        segmentFormat: new CmafOutputFormat(),
        targetDuration: SEGMENT_SECONDS,
        live: true,
        getPlaylistPath: ({ n }) => `${prefix}client_stream_${n}.m3u8`,
        getSegmentPath: ({ playlist, n }) => `${prefix}cs_${playlist.n}_${n}.m4s`,
        getInitPath: ({ n }) => `${prefix}cinit_${n}.mp4`,
        onMaster: (content) => {
          playlists.set('master.m3u8', content)
          playlists.set(`r${region}_master.m3u8`, content)
          trace.mark('masterRendered')
          kickPublish()
        },
        onPlaylist: (content, info) => {
          playlists.set(`${prefix}client_stream_${info.n}.m3u8`, content)
          ledger.noteDurations(region, info.n, segmentDurations(content))
        },
        onSegment: (target, info) => {
          const name = `${prefix}cs_${info.playlist.n}_${info.n}.m4s`
          ledger.noteEmitted(name)
          trace.mark('firstSegmentMuxed', (target as BufferTarget).buffer?.byteLength ?? '')
        },
      }),
      target: new PathedTarget('master.m3u8', ({ path }) => new BufferTarget({
        onFinalize: path.endsWith('.m3u8')
          ? undefined
          : (buffer) => admit(path, buffer),
      })),
    })

    const trim = {
      ...(startSeconds > 0 ? { start: startSeconds } : {}),
      ...(fillEndSeconds !== null ? { end: fillEndSeconds } : {}),
    }
    const current = await Conversion.init({
      input: plan.input,
      output,
      audio: { codec: 'aac' },
      ...(Object.keys(trim).length > 0 ? { trim } : {}),
    })
    if (!current.isValid) {
      throw new Error('client remux plan rejected by conversion: '
        + current.discardedTracks.map((track) => track.reason).join(', '))
    }
    current.onProgress = (progress) => {
      const regionSpan = Math.max((fillEndSeconds ?? plan.durationSeconds) - startSeconds, 0)
      onProgress?.(Math.round(((startSeconds + progress * regionSpan) / plan.durationSeconds) * 100))
    }
    conversion = current
    console.log(`[remux-worker] region ${region} converting from ${startSeconds}${fillEndSeconds !== null ? ` to ${fillEndSeconds} (fill)` : ''}`)
    trace.mark('convInit')
    restartPending = false
    if (region === 0) onHandle?.(handle)
    if (lastFollowMs !== null && uncovered(lastFollowMs)) restartAt(lastFollowMs)

    try {
      await current.execute()
    } catch (error) {
      const seekAbort = error instanceof ReadAbortedError && restartPending
      if (!(error instanceof ConversionCanceledError || seekAbort)) fail(error)
    }
    if (failure) throw failure
    if (pendingRestart) {
      await pendingRestart
      pendingRestart = null
    }
    if (seekTargetSeconds !== null) {
      fillEndSeconds = null
      nextStartSeconds = seekTargetSeconds
      continue
    }
    closeRegion()
    const finished = regions.find((r) => r.n === region)
    const wasFill = fillEndSeconds !== null
    fillEndSeconds = null
    if (finished && !wasFill) finished.ranToEnd = true
    if ((!wasFill && startSeconds <= COLD_BEHIND_MS / 1000) || timelineCovered()) break
    await settled(region)
    if (failure) throw failure
    if (pendingRestart) {
      await pendingRestart
      pendingRestart = null
    }
    if (seekTargetSeconds !== null) {
      nextStartSeconds = seekTargetSeconds
      continue
    }
    if (timelineCovered()) break
    const gap = nextGap()
    if (!gap) break
    const start = await snapToKeyframe(gap.startMs / 1000)
    const end = gap.endMs >= Math.round(plan.durationSeconds * 1000) ? null : gap.endMs / 1000 + SEGMENT_SECONDS
    nextStartSeconds = start
    fillEndSeconds = end !== null && end > start ? end : null
    console.log(`[remux-worker] gap ${gap.startMs}-${gap.endMs}: filling from ${start}`)
  }

  draining = true
  await queueIdle()
  if (failure) throw failure
  } finally {
    clearInterval(ticker)
    publishStopped = true
    if (kickTimer !== null) clearTimeout(kickTimer)
  }
  await publishing
  for (let round = 0; uploaded.length > 0 && round < DRAIN_ROUNDS; round += 1) await publish(false)
  await publish(true)
}

async function postMetadataWithRetry(roomID: string, mediaGeneration: number, token: string, chapters: MkvChapter[]): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await postJson(`/api/rooms/${encodeURIComponent(roomID)}/client-media/metadata`, {
        token, mediaGeneration, chapters,
      })
      if (response.ok || response.status < 500) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)))
  }
  console.warn('chapters were read but could not be posted; the timeline stays unmarked')
}

async function putWithRetry(url: string, headers: Record<string, string>, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= PUT_RETRIES; attempt += 1) {
    if (signal?.aborted) break
    try {
      const response = await fetch(url, { method: 'PUT', headers, signal, body: bytes as unknown as BodyInit })
      if (response.ok) return
      lastError = new Error(`segment PUT failed: ${response.status}`)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
