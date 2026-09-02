/**
 * The phase-3 gate: one media playlist covering disjoint regions of a
 * file, with EXT-X-DISCONTINUITY and a MAP per region and EXT-X-GAP
 * fillers over the holes, played by hls.js. If seeks land where they aim
 * and a gap does not throw playback to the live edge, the server can stop
 * cutting the playlist at the first hole and the offset scalar can go.
 */
import {
  ALL_FORMATS,
  BufferTarget,
  CmafOutputFormat,
  Conversion,
  CustomSource,
  HlsOutputFormat,
  Input,
  Output,
  PathedTarget,
} from 'mediabunny'
import { ReadGate, rangeStream } from '../src/pipeline/rangeRead'

interface Step { name: string; seekTo?: number; waitMs: number; currentTime: number; readyState: number; buffered: string; errors: string[]; playing: boolean }
interface Result { done: boolean; error?: string; regions: { start: number; end: number; segments: number; seconds: number }[]; playlist: string; steps: Step[] }

const params = new URLSearchParams(location.search)
const base = params.get('base') ?? 'http://127.0.0.1:8099/f'
const regions = (params.get('regions') ?? '0-30,600-630,1200-1230').split(',').map((r) => { const [a, b] = r.split('-').map(Number); return { start: a, end: b } })
const fill = Number(params.get('fill') ?? '4')
const out = document.getElementById('out')!
const video = document.getElementById('v') as HTMLVideoElement
const result: Result = { done: false, regions: [], playlist: '', steps: [] }
;(window as unknown as { __sparse: Result }).__sparse = result
const render = () => { out.textContent = JSON.stringify(result, null, 2) }

const objects = new Map<string, Uint8Array>()
const texts = new Map<string, string>()

interface RegionOut { start: number; end: number; init: string; segments: { name: string; duration: number }[] }

async function convertRegion(input: Input, index: number, start: number, end: number): Promise<RegionOut> {
  const prefix = `r${index}_`
  const region: RegionOut = { start, end, init: '', segments: [] }
  let playlist = ''
  const output = new Output({
    format: new HlsOutputFormat({
      segmentFormat: new CmafOutputFormat(),
      targetDuration: 4,
      live: false,
      getPlaylistPath: ({ n }) => `${prefix}stream_${n}.m3u8`,
      getSegmentPath: ({ playlist, n }) => `${prefix}cs_${playlist.n}_${n}.m4s`,
      getInitPath: ({ n }) => `${prefix}cinit_${n}.mp4`,
      onPlaylist: (content, info) => { if (info.n === 1) playlist = content },
      onInit: (target, info) => { const name = `${prefix}cinit_${info.n}.mp4`; objects.set(name, new Uint8Array((target as BufferTarget).buffer!)); if (info.n === 1) region.init = name },
      onSegment: (target, info) => { objects.set(`${prefix}cs_${info.playlist.n}_${info.n}.m4s`, new Uint8Array((target as BufferTarget).buffer!)) },
    }),
    target: new PathedTarget('master.m3u8', () => new BufferTarget()),
  })
  const conversion = await Conversion.init({ input, output, audio: { discard: true }, trim: { start, end } })
  if (!conversion.isValid) throw new Error('invalid conversion: ' + conversion.discardedTracks.map((t) => t.reason).join(','))
  await conversion.execute()
  const lines = playlist.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^#EXTINF:([\d.]+)/.exec(lines[i])
    if (m) region.segments.push({ name: lines[i + 1].trim(), duration: Number(m[1]) })
  }
  return region
}

// Gaps between regions are EXT-X-GAP segments, so cumulative time on the
// playlist equals absolute time in the file.
function compose(regionsOut: RegionOut[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.max(4, fill)}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-INDEPENDENT-SEGMENTS']
  let cursor = 0
  let gapIndex = 0
  for (const [i, region] of regionsOut.entries()) {
    if (region.start > cursor + 0.01) {
      if (i > 0) lines.push('#EXT-X-DISCONTINUITY')
      let left = region.start - cursor
      while (left > 0.01) {
        const d = Math.min(fill, left)
        lines.push(`#EXTINF:${d.toFixed(3)},`, '#EXT-X-GAP', `gap_${gapIndex++}.m4s`)
        left -= d
      }
      lines.push('#EXT-X-DISCONTINUITY')
    } else if (i > 0) {
      lines.push('#EXT-X-DISCONTINUITY')
    }
    lines.push(`#EXT-X-MAP:URI="${region.init}"`)
    let regionSeconds = 0
    for (const s of region.segments) { lines.push(`#EXTINF:${s.duration.toFixed(3)},`, s.name); regionSeconds += s.duration }
    cursor = region.start + regionSeconds
  }
  return lines.join('\n') + '\n'
}

async function main() {
  const head = await fetch(base, { method: 'HEAD' })
  const size = Number(head.headers.get('Content-Length'))
  const gate = new ReadGate()
  const source = new CustomSource({
    getSize: async () => size,
    read: (start, end) => rangeStream({ url: () => base, size, gate }, start, end),
    maxCacheSize: 96 * 2 ** 20,
    prefetchProfile: 'network',
  })
  const input = new Input({ source, formats: ALL_FORMATS })
  const regionsOut: RegionOut[] = []
  for (const [i, r] of regions.entries()) {
    const region = await convertRegion(input, i, r.start, r.end)
    regionsOut.push(region)
    result.regions.push({ start: r.start, end: r.end, segments: region.segments.length, seconds: region.segments.reduce((a, s) => a + s.duration, 0) })
    render()
  }
  const media = compose(regionsOut)
  result.playlist = media
  texts.set('media.m3u8', media)
  texts.set('master.m3u8', '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.640028"\nmedia.m3u8\n')
  render()

  // Served over http://mem/ (Playwright route.fulfill) so hls.js uses its own
  // loader and its real behaviour.
  ;(window as unknown as { __objects: () => Record<string, string> }).__objects = () => {
    const out: Record<string, string> = {}
    for (const [name, bytes] of objects) out[name] = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
    for (const [name, text] of texts) out[name] = btoa(unescape(encodeURIComponent(text)))
    return out
  }
  ;(window as unknown as { __built: boolean }).__built = true
  await new Promise<void>((resolve) => { (window as unknown as { __start: () => void }).__start = resolve })

  const { default: HlsClass } = await import('hls.js')
  const vod = params.get('vod') === '1'
  if (vod) texts.set('media.m3u8', media + '#EXT-X-ENDLIST\n')
  const errors: string[] = []
  const hls = new HlsClass({ debug: false, startPosition: 0 })
  hls.on(HlsClass.Events.ERROR, (_e, data) => {
    const line = `${data.type}/${data.details}${data.fatal ? ' FATAL' : ''}${data.frag ? ` frag=${data.frag.sn}@${data.frag.start.toFixed(1)}` : ''}`
    errors.push(line)
    console.error('[hls]', line, data.error?.message ?? '')
  })
  const parsed = new Promise<void>((resolve) => hls.on(HlsClass.Events.MANIFEST_PARSED, () => resolve()))
  hls.on(HlsClass.Events.MEDIA_ATTACHED, () => { console.log('[hls] media attached'); hls.loadSource('http://mem/master.m3u8') })
  hls.attachMedia(video)
  await parsed
  console.log('[hls] manifest parsed')

  const snapshot = (name: string, seekTo: number | undefined, waitMs: number): Step => {
    const ranges: string[] = []
    for (let i = 0; i < video.buffered.length; i += 1) ranges.push(`${video.buffered.start(i).toFixed(1)}-${video.buffered.end(i).toFixed(1)}`)
    return { name, seekTo, waitMs, currentTime: Math.round(video.currentTime * 10) / 10, readyState: video.readyState, buffered: ranges.join(' '), errors: errors.splice(0), playing: !video.paused && !video.ended && video.readyState > 2 }
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  void video.play().catch(() => undefined)
  await wait(4000)
  result.steps.push(snapshot('play from 0', undefined, 4000)); render()
  const seeks: [string, number][] = [
    ['seek into region 1', regions[1].start + 10],
    ['seek into the gap before region 2', regions[1].end + 200],
    ['seek into region 2', regions[2].start + 10],
    ['seek back into region 0', 5],
    ['seek to the tail of region 1', regions[1].end - 3],
  ]
  for (const [name, at] of seeks) {
    video.currentTime = at
    void video.play().catch(() => undefined)
    await wait(5000)
    result.steps.push(snapshot(name, at, 5000)); render()
  }
  hls.destroy()
}

main().then(() => { result.done = true; render() }).catch((error: unknown) => {
  result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  result.done = true
  render()
})
