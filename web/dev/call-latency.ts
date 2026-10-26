// Voice latency rig over the real MoQ relay. `?role=talk` captures the microphone
// (a fake one fed by a click track under Playwright) with the call's processing on,
// publishes it as voice, and timestamps every click the capture hands over. `?role=listen`
// subscribes to the same path and timestamps every click that reaches the speakers'
// graph. Both stamps are wall clock (timeOrigin + performance time), so two tabs of the
// same browser compare directly. Query: relay (url with token), path, latency (ms or
// real-time), max (ms).
import * as Publish from '@moq/publish'
import * as Watch from '@moq/watch'

const query = new URLSearchParams(location.search)
const out = document.getElementById('out')!
const stamps: number[] = []
;(window as unknown as { stamps: number[]; info: Record<string, unknown> }).stamps = stamps
const info: Record<string, unknown> = {}
;(window as unknown as { info: Record<string, unknown> }).info = info
const log = (line: string) => { out.textContent += line + '\n' }

// An onset detector: a loud sample with no loud one in the 300 ms before it is one click.
// It reports the context time of that exact sample, so detection adds no quantum of its own.
const DETECTOR = `
class Onset extends AudioWorkletProcessor {
  constructor() { super(); this.at = 0; this.loud = -1e9; this.peak = 0; this.n = 0 }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      const v = Math.abs(channel[i])
      if (v > this.peak) this.peak = v
      this.at++
      if (v > 0.2) {
        if (this.at - this.loud > sampleRate * 0.3) this.port.postMessage(currentTime + i / sampleRate)
        this.loud = this.at
      }
    }
    if (++this.n % 375 === 0) { this.port.postMessage({ peak: this.peak }); this.peak = 0 }
    return true
  }
}
registerProcessor('onset', Onset)`

async function detect(ctx: AudioContext, node: AudioNode, extraMs: () => number) {
  const url = URL.createObjectURL(new Blob([DETECTOR], { type: 'text/javascript' }))
  await ctx.audioWorklet.addModule(url)
  const onset = new AudioWorkletNode(ctx, 'onset')
  node.connect(onset)
  // Keep the detector pulled by the graph.
  const sink = ctx.createGain(); sink.gain.value = 0
  onset.connect(sink).connect(ctx.destination)
  setInterval(() => { info.state = ctx.state; info.time = ctx.currentTime }, 500)
  onset.port.onmessage = (event) => {
    info.msgs = ((info.msgs as number) ?? 0) + 1
    if (typeof event.data === 'object') { ((info.peaks ??= []) as number[]).push(+event.data.peak.toFixed(3)); return }
    const contextTime = event.data as number
    const stamp = ctx.getOutputTimestamp()
    const perf = (stamp.performanceTime ?? performance.now()) + (contextTime - (stamp.contextTime ?? ctx.currentTime)) * 1000
    const wall = performance.timeOrigin + perf + extraMs()
    stamps.push(wall)
    log(`click ${stamps.length} @ ${wall.toFixed(1)}`)
  }
}

const relay = query.get('relay')!
const path = query.get('path')!
const role = query.get('role')
const keep: unknown[] = []
;(window as unknown as { keep: unknown[] }).keep = keep

if (role === 'talk') {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const [track] = stream.getAudioTracks()
  const ctx = new AudioContext({ latencyHint: 'interactive' })
  info.settings = track.getSettings()
  // The mouth is when the capture hands the click over, before any encoding.
  await detect(ctx, ctx.createMediaStreamSource(stream), () => 0)
  const connection = new Publish.Net.Connection.Reload({ url: new URL(relay), enabled: true, websocket: { enabled: false } })
  const broadcast = new Publish.Broadcast({ connection: connection.established, enabled: true, name: Publish.Net.Path.from(path) })
  const audio = new Publish.Audio.Encoder('audio', {
    broadcast,
    enabled: true,
    source: { track: track as Publish.Audio.StreamTrack, kind: 'voice' },
    codec: { mime: 'opus', bitrate: 32_000 },
  })
  broadcast.net.subscribe((producer) => { if (producer) { info.ready = true; log('published') } })
  // Block-scoped objects are collectable once the module finishes; the page holds them.
  keep.push(connection, broadcast, audio)
} else {
  const latencyParam = query.get('latency') ?? 'real-time'
  const min = (latencyParam === 'real-time' ? 'real-time' : Number(latencyParam)) as Watch.Bound
  const max = (query.get('max') ? Number(query.get('max')) : min) as Watch.Bound
  const connection = new Watch.Net.Connection.Reload({ url: new URL(relay), enabled: true, websocket: { enabled: false } })
  const broadcast = new Watch.Broadcast({ connection: connection.established, enabled: true, name: Watch.Net.Path.from(path) })
  const source = new Watch.Audio.Source({ broadcast, supported: Watch.Audio.Decoder.supported })
  const sync = new Watch.Sync({ latency: { min, max }, connection: connection.established, audio: source.out.jitter })
  const enabled = new Watch.Signals.Signal(false)
  const decoder = new Watch.Audio.Decoder(source, sync, { enabled })
  const emitter = new Watch.Audio.Emitter(decoder, { volume: 1, muted: false, paused: false })
  const effect = new Watch.Signals.Effect()
  effect.proxy(enabled, emitter.out.enabled)
  effect.run((e) => {
    const ctx = e.get(decoder.out.context)
    const root = e.get(decoder.out.root)
    if (!ctx || !root) return
    // The decoder may rebuild its context; every new one gets a detector.
    info.outputLatencyMs = (ctx.outputLatency ?? 0) * 1000
    info.baseLatencyMs = ctx.baseLatency * 1000
    // The ear is after the output device too, so its own latency is added.
    void detect(ctx, root, () => (ctx.outputLatency ?? 0) * 1000).then(() => { info.ready = true; log('listening') })
  })
  keep.push(connection, broadcast, source, sync, decoder, emitter, effect)
  setInterval(() => { info.buffer = sync.out.buffer.peek(); info.jitter = sync.out.jitter.peek() }, 500)
}
