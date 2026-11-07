import { MAX_LEVEL } from '../ui/VolumeSlider'

type Graph = {
  context: AudioContext
  source: MediaElementAudioSourceNode
  /** Áudio estável: a compressor and the gain that makes up for it, between the source and the boost. */
  steady: { compressor: DynamicsCompressorNode; makeup: GainNode; on: boolean }
  gain: GainNode
}

const graphs = new WeakMap<HTMLMediaElement, Graph>()

/** How much the steady compressor brings the quiet parts up, once it has pulled the loud ones down. */
const STEADY_MAKEUP_DB = 9

/**
 * Whether the element's sound can go through Web Audio. Native HLS (no MSE)
 * hands Safari a stream it plays silent once routed through a graph, so only
 * a MediaSource-backed element gets the boost.
 */
export function canBoost(media: HTMLMediaElement): boolean {
  if (graphs.has(media)) return true
  const scope = globalThis as { AudioContext?: typeof AudioContext }
  return scope.AudioContext !== undefined && media.src.startsWith('blob:')
}

/** The gain past full volume, 1 when nothing is boosted. */
export function boostOf(media: HTMLMediaElement): number {
  return graphs.get(media)?.gain.gain.value ?? 1
}

/**
 * The element's graph, built the first time it is needed, from a user gesture,
 * since a suspended context mutes the element for good; after that it stays,
 * and with nothing on it is a pass-through.
 */
function graphFor(media: HTMLMediaElement): Graph | null {
  const built = graphs.get(media)
  if (built) {
    if (built.context.state === 'suspended') void built.context.resume().catch(() => {})
    return built
  }
  if (!canBoost(media)) return null
  try {
    const context = new AudioContext()
    const source = context.createMediaElementSource(media)
    const compressor = new DynamicsCompressorNode(context, { threshold: -30, knee: 12, ratio: 6, attack: 0.005, release: 0.3 })
    const makeup = new GainNode(context, { gain: 10 ** (STEADY_MAKEUP_DB / 20) })
    const gain = context.createGain()
    // Past full volume the peaks would clip; the limiter flattens them instead.
    const limiter = new DynamicsCompressorNode(context, { threshold: -1, knee: 0, ratio: 20, attack: 0.003, release: 0.25 })
    compressor.connect(makeup).connect(gain)
    gain.connect(limiter).connect(context.destination)
    source.connect(gain)
    const graph = { context, source, steady: { compressor, makeup, on: false }, gain }
    graphs.set(media, graph)
    return graph
  } catch {
    return null
  }
}

/** Sets the gain past full volume; the graph is only built for a gain above 1. */
export function setBoost(media: HTMLMediaElement, gain: number): number {
  if (!graphs.has(media) && gain <= 1) return 1
  const graph = graphFor(media)
  if (!graph) return 1
  const next = Math.min(Math.max(gain, 1), MAX_LEVEL)
  graph.gain.gain.value = next
  return next
}

/**
 * Áudio estável: dialogue and explosions brought closer together, for films
 * mixed for a cinema (a 5.1 mix folded to two speakers leaves the voices far
 * below the effects). Returns whether it is on.
 */
export function setSteady(media: HTMLMediaElement, on: boolean): boolean {
  if (!on && !graphs.has(media)) return false
  const graph = graphFor(media)
  if (!graph) return false
  if (graph.steady.on === on) return on
  graph.source.disconnect()
  graph.source.connect(on ? graph.steady.compressor : graph.gain)
  graph.steady.on = on
  return on
}
