/**
 * What to hand a person when a preparo fails.
 *
 * "The codec or format is not supported here" is the least actionable
 * sentence in the app: it names a verdict and no evidence. Everything that
 * decided it is known in the browser at that moment — which codec the file
 * carries, which ones this browser will decode, what the worker was doing,
 * how far the download got — and none of it survives into a message someone
 * can paste. This gathers it.
 *
 * It is written to be read by a person and pasted into an issue, so it is
 * plain text with stable headings rather than JSON.
 */
import type { RoomInfo } from './types'

const VIDEO_PROBES: { label: string; config: VideoDecoderConfig }[] = [
  { label: 'H.264 (avc1.640028)', config: { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 } },
  { label: 'HEVC (hvc1.1.6.L93.B0)', config: { codec: 'hvc1.1.6.L93.B0', codedWidth: 1920, codedHeight: 1080 } },
  { label: 'VP9 (vp09.00.10.08)', config: { codec: 'vp09.00.10.08', codedWidth: 1920, codedHeight: 1080 } },
  { label: 'AV1 (av01.0.08M.08)', config: { codec: 'av01.0.08M.08', codedWidth: 1920, codedHeight: 1080 } },
]

const AUDIO_PROBES: { label: string; config: AudioDecoderConfig }[] = [
  { label: 'AAC (mp4a.40.2)', config: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 } },
  { label: 'Opus', config: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 } },
  { label: 'AC-3', config: { codec: 'ac-3', sampleRate: 48000, numberOfChannels: 6 } },
  { label: 'E-AC-3', config: { codec: 'ec-3', sampleRate: 48000, numberOfChannels: 6 } },
  { label: 'FLAC', config: { codec: 'flac', sampleRate: 48000, numberOfChannels: 2 } },
]

async function videoSupport(): Promise<string[]> {
  if (typeof VideoDecoder === 'undefined') return ['WebCodecs video: not available in this browser']
  return await Promise.all(VIDEO_PROBES.map(async ({ label, config }) => {
    try {
      const { supported } = await VideoDecoder.isConfigSupported(config)
      return `${label}: ${supported ? 'decodes' : 'no'}`
    } catch (error) {
      return `${label}: no (${error instanceof Error ? error.message : String(error)})`
    }
  }))
}

async function audioSupport(): Promise<string[]> {
  if (typeof AudioDecoder === 'undefined') return ['WebCodecs audio: not available in this browser']
  const rows = await Promise.all(AUDIO_PROBES.map(async ({ label, config }) => {
    try {
      const { supported } = await AudioDecoder.isConfigSupported(config)
      return `${label}: ${supported ? 'decodes' : 'no'}`
    } catch (error) {
      return `${label}: no (${error instanceof Error ? error.message : String(error)})`
    }
  }))
  try {
    const { supported } = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 })
    rows.push(`AAC encode (required for every non-AAC track): ${supported ? 'yes' : 'no'}`)
  } catch (error) {
    rows.push(`AAC encode (required for every non-AAC track): no (${error instanceof Error ? error.message : String(error)})`)
  }
  return rows
}

function roomLines(room: RoomInfo): string[] {
  const swarm = room.preparation?.swarm
  const lines = [
    `id: ${room.id}`,
    `source: ${room.sourceKind}`,
    `file: ${room.fileName}`,
    `status: ${room.status}`,
    `media generation/version: ${room.mediaGeneration}/${room.mediaVersion ?? 0}`,
    `duration: ${room.durationMs ?? 0} ms`,
    `regions: ${(room.mediaRegions ?? []).map((r) => `r${r.n}@${r.startMs}+${r.producedMs}${r.growing ? '*' : ''}`).join(' ') || 'none'}`,
    `audio tracks: ${room.audioTracks?.length ?? 0}, subtitle tracks: ${room.subtitleTracks?.length ?? 0}`,
  ]
  if (room.errorMessage) lines.push(`server error: ${room.errorMessage}`)
  if (swarm) {
    lines.push(`swarm: ${swarm.peers} peers, ${swarm.downSpeed} B/s, ${swarm.haveBytes} of ${swarm.selectedBytes} bytes`)
  }
  const received = room.preparation?.receivedBytes
  const total = room.preparation?.sourceBytes
  if (received !== undefined || total !== undefined) lines.push(`uploaded: ${received ?? 0} of ${total ?? 0} bytes`)
  return lines
}

function browserLines(): string[] {
  const nav = navigator as Navigator & { deviceMemory?: number }
  return [
    `user agent: ${nav.userAgent}`,
    `languages: ${nav.languages?.join(', ') ?? nav.language}`,
    `cores: ${nav.hardwareConcurrency ?? 'unknown'}, memory: ${nav.deviceMemory ?? 'unknown'} GB`,
    `secure context: ${window.isSecureContext}, cross-origin isolated: ${window.crossOriginIsolated}`,
    `origin: ${location.origin}`,
    `workers: ${typeof Worker !== 'undefined' ? 'yes' : 'no'}, WebCodecs: ${typeof VideoDecoder !== 'undefined' ? 'yes' : 'no'}`,
  ]
}

export interface DiagnosticsInput {
  room: RoomInfo
  failure: string | null
  detail: string | null
}

export async function buildDiagnostics({ room, failure, detail }: DiagnosticsInput): Promise<string> {
  const [video, audio] = await Promise.all([videoSupport(), audioSupport()])
  const section = (title: string, lines: string[]) => [`## ${title}`, ...lines, ''].join('\n')
  return [
    `# juntos.lol — preparo failure report`,
    `${new Date().toISOString()}`,
    '',
    section('What failed', [
      `screen: ${failure ?? 'unknown'}`,
      `reason: ${detail ?? 'the pipeline gave no reason'}`,
    ]),
    section('Room', roomLines(room)),
    section('Browser', browserLines()),
    section('Video codecs this browser decodes', video),
    section('Audio codecs this browser decodes', audio),
  ].join('\n')
}
