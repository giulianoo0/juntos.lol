/**
 * What this browser can actually decode.
 *
 * The pipeline stream-copies H.264, HEVC, AV1 and VP9 and refuses everything
 * else outright — there is no transcode fallback — so those four are exactly
 * the answers that decide whether a given room will play. A viewer whose
 * browser cannot decode one of them meets that fact as a video that never
 * starts, which reads as the app being broken.
 */

export type CodecID = 'h264' | 'hevc' | 'av1' | 'vp9'

export interface CodecProbe {
  id: CodecID
  label: string
  /** Every variant the pipeline can emit; supported only when all of them are. */
  mimeTypes: string[]
}

export interface CodecSupport extends CodecProbe {
  supported: boolean
}

/** Oracle for a MIME type, or null when the browser offers no way to ask. */
export type CodecOracle = ((mimeType: string) => boolean) | null

export const CODEC_PROBES: CodecProbe[] = [
  {
    id: 'h264',
    label: 'H.264 / AVC',
    mimeTypes: ['video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.42E01E"'],
  },
  {
    id: 'hevc',
    label: 'HEVC / H.265',
    mimeTypes: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hvc1.2.4.L120.90"'],
  },
  {
    id: 'av1',
    label: 'AV1',
    mimeTypes: ['video/mp4; codecs="av01.0.05M.08"', 'video/mp4; codecs="av01.0.05M.10"'],
  },
  {
    id: 'vp9',
    label: 'VP9',
    mimeTypes: ['video/mp4; codecs="vp09.00.40.08"', 'video/mp4; codecs="vp09.02.40.10"'],
  },
]

/**
 * MediaSource is asked first because that is what plays here: canPlayType can
 * answer yes for a codec MSE then refuses.
 */
export function browserOracle(): CodecOracle {
  if (typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function') {
    return (mimeType) => MediaSource.isTypeSupported(mimeType)
  }
  if (typeof document !== 'undefined') {
    const video = document.createElement('video')
    if (typeof video.canPlayType === 'function') {
      return (mimeType) => video.canPlayType(mimeType) === 'probably'
    }
  }
  return null
}

export function detectCodecSupport(oracle: CodecOracle = browserOracle()): CodecSupport[] {
  return CODEC_PROBES.map((probe) => ({
    ...probe,
    supported: oracle === null || probe.mimeTypes.every(oracle),
  }))
}

export function unsupportedCodecs(support: CodecSupport[]): CodecSupport[] {
  return support.filter((codec) => !codec.supported)
}

/**
 * Reads the list this app writes and the older whole-answer form
 * (`h264:1,hevc:0`), where only the entries marked unsupported were a
 * complaint. Anything unrecognised is ignored.
 */
export function dismissedCodecs(stored: string): Set<CodecID> {
  const known = new Set<string>(CODEC_PROBES.map((probe) => probe.id))
  const ids = new Set<CodecID>()
  for (const entry of stored.split(',')) {
    const [id, reported] = entry.split(':')
    if (reported === '1') continue
    if (known.has(id)) ids.add(id as CodecID)
  }
  return ids
}

export function unacknowledgedCodecs(support: CodecSupport[], dismissed: Set<CodecID>): CodecSupport[] {
  return unsupportedCodecs(support).filter((codec) => !dismissed.has(codec.id))
}

/**
 * Every codec ever reported, not merely the ones reported now: the probe is
 * not stable across days, and a codec that comes back is not news.
 */
export function dismissalRecord(stored: string, support: CodecSupport[]): string {
  const ids = dismissedCodecs(stored)
  for (const codec of unsupportedCodecs(support)) ids.add(codec.id)
  return CODEC_PROBES.filter((probe) => ids.has(probe.id)).map((probe) => probe.id).join(',')
}
