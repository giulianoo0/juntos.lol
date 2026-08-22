/**
 * What this browser can actually decode.
 *
 * The pipeline stream-copies H.264, HEVC and AV1 and transcodes everything
 * else to H.264, so those three are exactly the answers that decide whether a
 * given room will play. A viewer whose browser cannot decode one of them meets
 * that fact as a video that never starts, which reads as the app being broken.
 */

export type CodecID = 'h264' | 'hevc' | 'av1'

export interface CodecProbe {
  id: CodecID
  /** The name to show. HEVC and H.265 are the same codec under two names. */
  label: string
  /**
   * Every variant the pipeline can emit for this codec. A codec counts as
   * supported only when all of them do: a browser that decodes 8-bit HEVC but
   * not 10-bit cannot play the releases this app sees, and reporting it as
   * supported would cost someone a player that never starts.
   */
  mimeTypes: string[]
}

export interface CodecSupport extends CodecProbe {
  supported: boolean
}

/** Oracle for a MIME type, or null when the browser offers no way to ask. */
export type CodecOracle = ((mimeType: string) => boolean) | null

// Codec strings chosen to match what the remux actually writes: libx264 at
// High for the transcode target, and the hvc1/av01 strings ffmpeg produces
// when it copies a source through.
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
]

/**
 * How the running browser answers, or null if it will not.
 *
 * MediaSource is asked first because that is what plays here: hls.js feeds
 * segments through Media Source Extensions, and canPlayType can answer yes for
 * a codec MSE then refuses.
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
    // Silence beats a false alarm: with nothing to ask, claim everything works
    // rather than warning about codecs that may well be fine.
    supported: oracle === null || probe.mimeTypes.every(oracle),
  }))
}

export function unsupportedCodecs(support: CodecSupport[]): CodecSupport[] {
  return support.filter((codec) => !codec.supported)
}

/**
 * The codecs a stored dismissal covered.
 *
 * Reads the list this app writes, and the older whole-answer form
 * (`h264:1,hevc:0`) it used to write, where only the entries marked
 * unsupported were ever a complaint. Anything unrecognised is ignored, so a
 * record written by a future version costs a repeat warning at worst.
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

/**
 * What will not play and has not already been said.
 *
 * The probe is not a fixed property of a browser. Chrome answers for HEVC out
 * of the machine's hardware video decoding, which switches off and on by
 * itself — a GPU process that crashed, a driver the blocklist started
 * refusing, the acceleration setting. So the same browser gives different
 * answers on different days, and a viewer who is told twice about the same
 * codec learns only that the app nags.
 */
export function unacknowledgedCodecs(support: CodecSupport[], dismissed: Set<CodecID>): CodecSupport[] {
  return unsupportedCodecs(support).filter((codec) => !dismissed.has(codec.id))
}

/**
 * What to store when this answer is dismissed: every codec ever reported, not
 * merely the ones reported now. A codec that comes back is not news, and a
 * browser that gained one back has not grown a problem worth a modal.
 */
export function dismissalRecord(stored: string, support: CodecSupport[]): string {
  const ids = dismissedCodecs(stored)
  for (const codec of unsupportedCodecs(support)) ids.add(codec.id)
  return CODEC_PROBES.filter((probe) => ids.has(probe.id)).map((probe) => probe.id).join(',')
}
