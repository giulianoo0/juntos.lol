/**
 * The throughput rig behind the phase-0 architecture gate: does the real
 * remux, reading through the resilient Range reader with the prefetch and
 * cache settings the worker client will use, sustain well over real time
 * at WAN latency? Runs in a real browser because the h2 receive window that
 * bounds a download is the browser's, not Node's.
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

interface Measure {
  done: boolean
  error?: string
  size: number
  seconds: number
  bytesRead: number
  requests: number
  mbitPerSecond: number
  sustainedMbitPerSecond: number
  firstSegmentMs: number | null
  segments: number
  producedSeconds: number
  realtimeRatio: number | null
  windows: number[]
}

const params = new URLSearchParams(location.search)
const base = params.get('base') ?? 'http://127.0.0.1:8099/f'
const seconds = Number(params.get('seconds') ?? '60')
const withAudio = params.get('audio') === '1'
const cacheMiB = Number(params.get('cache') ?? '96')
const out = document.getElementById('out')!
const result: Measure = {
  done: false, size: 0, seconds, bytesRead: 0, requests: 0, mbitPerSecond: 0, sustainedMbitPerSecond: 0,
  firstSegmentMs: null, segments: 0, producedSeconds: 0, realtimeRatio: null, windows: [],
}
;(window as unknown as { __measure: Measure }).__measure = result

function render() {
  out.textContent = JSON.stringify(result, null, 2)
}

async function main() {
  const head = await fetch(base, { method: 'HEAD' })
  result.size = Number(head.headers.get('Content-Length'))
  if (!Number.isFinite(result.size) || result.size <= 0) throw new Error(`no size from ${base}`)
  const gate = new ReadGate()
  const origFetch = window.fetch
  window.fetch = (input, init) => { result.requests += 1; return origFetch(input, init) }
  const source = new CustomSource({
    getSize: async () => result.size,
    read: (start, end) => rangeStream({
      url: () => base,
      size: result.size,
      gate,
      onBytes: (n) => { result.bytesRead += n },
    }, start, end),
    maxCacheSize: cacheMiB * 2 ** 20,
    prefetchProfile: 'network',
  })
  const input = new Input({ source, formats: ALL_FORMATS })
  const duration = await input.computeDuration()
  const t0 = performance.now()
  const counts = new Map<number, number>()
  const output = new Output({
    format: new HlsOutputFormat({
      segmentFormat: new CmafOutputFormat(),
      targetDuration: 4,
      live: true,
      onSegment: (_target, info) => {
        if (result.firstSegmentMs === null) result.firstSegmentMs = Math.round(performance.now() - t0)
        counts.set(info.playlist.n, (counts.get(info.playlist.n) ?? 0) + 1)
        result.segments = Math.max(...counts.values())
      },
    }),
    target: new PathedTarget('master.m3u8', () => new BufferTarget()),
  })
  const conversion = await Conversion.init({
    input,
    output,
    audio: withAudio ? { codec: 'aac' } : { discard: true },
  })
  if (!conversion.isValid) throw new Error('conversion invalid: ' + conversion.discardedTracks.map((t) => t.reason).join(','))
  // Throughput over 5 s windows; "sustained" is the median of them, which
  // ignores the warm-up and the tail.
  let windowStart = result.bytesRead
  const ticker = setInterval(() => {
    const now = result.bytesRead
    result.windows.push(Math.round((now - windowStart) * 8 / 5 / 1e6 * 10) / 10)
    windowStart = now
    const elapsed = (performance.now() - t0) / 1000
    result.mbitPerSecond = Math.round(result.bytesRead * 8 / elapsed / 1e6 * 10) / 10
    result.producedSeconds = result.segments * 4
    result.realtimeRatio = elapsed > 0 ? Math.round(result.producedSeconds / elapsed * 100) / 100 : null
    render()
  }, 5000)
  const stop = setTimeout(() => { void conversion.cancel() }, seconds * 1000)
  try {
    await conversion.execute()
  } catch (error) {
    if (!(error instanceof Error && error.name === 'ConversionCanceledError')) throw error
  } finally {
    clearTimeout(stop)
    clearInterval(ticker)
  }
  const elapsed = (performance.now() - t0) / 1000
  result.seconds = Math.round(elapsed * 10) / 10
  result.mbitPerSecond = Math.round(result.bytesRead * 8 / elapsed / 1e6 * 10) / 10
  const sorted = [...result.windows].sort((a, b) => a - b)
  result.sustainedMbitPerSecond = sorted.length ? sorted[Math.floor(sorted.length / 2)] : result.mbitPerSecond
  result.producedSeconds = Math.min(result.segments * 4, duration)
  result.realtimeRatio = Math.round(result.producedSeconds / elapsed * 100) / 100
  gate.close()
}

main().then(() => { result.done = true; render() }).catch((error: unknown) => {
  result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  result.done = true
  render()
})
