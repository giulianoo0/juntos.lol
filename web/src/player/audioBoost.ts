import { MAX_LEVEL } from '../ui/VolumeSlider'

type Graph = { context: AudioContext; gain: GainNode }

const graphs = new WeakMap<HTMLMediaElement, Graph>()

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
 * Sets the gain past full volume. The graph is only built the first time it
 * is needed, from a user gesture, since a suspended context mutes the element
 * for good; after that it stays and a gain of 1 is a pass-through.
 */
export function setBoost(media: HTMLMediaElement, gain: number): number {
  let graph = graphs.get(media)
  if (!graph) {
    if (gain <= 1 || !canBoost(media)) return 1
    try {
      const context = new AudioContext()
      const node = context.createGain()
      context.createMediaElementSource(media).connect(node).connect(context.destination)
      graph = { context, gain: node }
      graphs.set(media, graph)
    } catch {
      return 1
    }
  }
  if (graph.context.state === 'suspended') void graph.context.resume().catch(() => {})
  const next = Math.min(Math.max(gain, 1), MAX_LEVEL)
  graph.gain.gain.value = next
  return next
}
