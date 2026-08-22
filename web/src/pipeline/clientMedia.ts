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
 * Everything here degrades silently: any failure, at any point, hands the
 * upload back to the tus path unchanged.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CmafOutputFormat,
  Conversion,
  HlsOutputFormat,
  Input,
  Output,
  PathedTarget,
  canEncodeAudio,
} from 'mediabunny'
import { registerAc3Decoder } from '@mediabunny/ac3'
import { registerDtsDecoder } from '@mediabunny/dts'
import { registerAacEncoder } from '@mediabunny/aac-encoder'

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

export interface ClientRemuxPlan {
  input: Input
  audioTracks: { language: string }[]
  durationSeconds: number
}

/**
 * Decides whether this browser can prepare this file itself. Null means the
 * tus path should run instead — a verdict, never an error.
 */
export async function planClientRemux(file: File): Promise<ClientRemuxPlan | null> {
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
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
  contentType: string
}

export interface RunClientRemuxOptions {
  roomID: string
  mediaGeneration: number
  file: File
  plan: ClientRemuxPlan
  onProgress?: (pct: number) => void
}

/**
 * Runs the whole pipeline: claim, remux, upload, publish, complete. Throws
 * on any failure after releasing the claim, so the caller can fall back to
 * tus against a room that is exactly as it was.
 */
export async function runClientRemux({ roomID, mediaGeneration, file, plan, onProgress }: RunClientRemuxOptions): Promise<void> {
  const claimResponse = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/client-media/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!claimResponse.ok) throw new Error(`client media claim refused: ${claimResponse.status}`)
  const { claim, mediaGeneration: serverGeneration } = await claimResponse.json() as ClaimResponse
  if (serverGeneration !== mediaGeneration) {
    await releaseClaim(roomID, claim)
    throw new Error('client media claim raced a source swap')
  }

  try {
    await remuxAndPublish({ roomID, mediaGeneration, file, plan, claim, onProgress })
  } catch (error) {
    await releaseClaim(roomID, claim).catch(() => {})
    throw error
  }
}

async function releaseClaim(roomID: string, claim: string): Promise<void> {
  await fetch(`/api/rooms/${encodeURIComponent(roomID)}/client-media?claim=${encodeURIComponent(claim)}`, {
    method: 'DELETE',
  })
}

async function remuxAndPublish({ roomID, mediaGeneration, plan, claim, onProgress }: RunClientRemuxOptions & { claim: string }): Promise<void> {
  // Object flow: the muxer hands finished files to `pending`; `pump` drains
  // them through presign + PUT into `uploaded`; each publish confirms
  // `uploaded` names with the server, which HEADs the bucket and extends the
  // published set the playlists are cut against.
  const pending: PendingObject[] = []
  const uploaded: string[] = []
  const playlists = new Map<string, string>()
  let uploadFailure: unknown = null
  let pumping = Promise.resolve()
  let metadataSent = false

  const enqueue = (name: string, target: unknown, contentType: string) => {
    const buffer = (target as BufferTarget).buffer
    if (!buffer) {
      uploadFailure ??= new Error(`segment ${name} finished without bytes`)
      return
    }
    pending.push({ name, bytes: new Uint8Array(buffer), contentType })
    pumping = pumping.then(() => pump()).catch((error: unknown) => { uploadFailure ??= error })
  }

  const pump = async () => {
    while (pending.length > 0) {
      const batch = pending.splice(0, PRESIGN_BATCH)
      const presign = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/client-media/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claim,
          objects: batch.map((object) => ({ name: object.name, size: object.bytes.byteLength })),
        }),
      })
      if (!presign.ok) throw new Error(`presign refused: ${presign.status}`)
      const { objects } = await presign.json() as { objects: { name: string; url: string; headers: Record<string, string> }[] }
      const byName = new Map(objects.map((object) => [object.name, object]))
      await Promise.all(batch.map(async (object) => {
        const signed = byName.get(object.name)
        if (!signed) throw new Error(`presign missing ${object.name}`)
        await putWithRetry(signed.url, signed.headers, object.bytes)
        uploaded.push(object.name)
      }))
    }
  }

  const publish = async (complete: boolean) => {
    const confirm = uploaded.splice(0, 128)
    const body: Record<string, unknown> = {
      claim,
      mediaGeneration,
      confirm,
      playlists: Object.fromEntries(playlists),
      complete,
    }
    if (!metadataSent) {
      body.audioTracks = plan.audioTracks.map((track) => ({ language: track.language, title: '' }))
      metadataSent = true
    }
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/client-media/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`publish refused: ${response.status}`)
    const { confirmed } = await response.json() as { confirmed: string[] }
    // Whatever the bucket did not vouch for is claimed again next round.
    const vouched = new Set(confirmed)
    for (const name of confirm) if (!vouched.has(name)) uploaded.push(name)
  }

  const output = new Output({
    format: new HlsOutputFormat({
      segmentFormat: new CmafOutputFormat(),
      targetDuration: SEGMENT_SECONDS,
      live: true,
      getPlaylistPath: ({ n }) => `client_stream_${n}.m3u8`,
      getSegmentPath: ({ playlist, n }) => `cs_${playlist.n}_${n}.m4s`,
      getInitPath: ({ n }) => `cinit_${n}.mp4`,
      onMaster: (content) => { playlists.set('master.m3u8', content) },
      onPlaylist: (content, info) => { playlists.set(`client_stream_${info.n}.m3u8`, content) },
      onInit: (target, info) => enqueue(`cinit_${info.n}.mp4`, target, 'video/mp4'),
      onSegment: (target, info) => enqueue(`cs_${info.playlist.n}_${info.n}.m4s`, target, 'video/iso.segment'),
    }),
    target: new PathedTarget('master.m3u8', () => new BufferTarget()),
  })

  const conversion = await Conversion.init({
    input: plan.input,
    output,
    audio: { codec: 'aac' },
  })
  if (!conversion.isValid) {
    throw new Error('client remux plan rejected by conversion: '
      + conversion.discardedTracks.map((track) => track.reason).join(', '))
  }
  conversion.onProgress = (progress) => onProgress?.(Math.round(progress * 100))

  // Publishing runs alongside the remux for the same reason the server's
  // does: a room that only became watchable at the end would not be a
  // preview. Failures inside the loop surface on the next tick.
  let publishing = false
  const ticker = setInterval(() => {
    if (publishing || uploadFailure) return
    publishing = true
    void publish(false)
      .catch((error: unknown) => { uploadFailure ??= error })
      .finally(() => { publishing = false })
  }, PUBLISH_INTERVAL_MS)

  try {
    await conversion.execute()
    await pumping
    if (uploadFailure) throw uploadFailure
  } finally {
    clearInterval(ticker)
  }
  // Drain: every object confirmed, final playlists (ENDLIST included), done.
  while (uploaded.length > 0) await publish(false)
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
