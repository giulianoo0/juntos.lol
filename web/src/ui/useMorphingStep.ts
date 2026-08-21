import { useEffect, useState } from 'react'

/**
 * How long the outgoing step is given to dissolve before the next one is
 * mounted in its place. Short enough that a click still feels answered
 * immediately, long enough that the two states are never on screen together.
 */
export const MORPH_OUT_MS = 90

/**
 * Holds the rendered step one beat behind the requested one.
 *
 * The swap has to wait for the outgoing content to dissolve; mounting the next
 * one in the same commit would cut between two sharp states, which is the one
 * thing a morph must not do. `morphing` is what the blur hangs off.
 */
export function useMorphingStep<T>(step: T): { shown: T; morphing: boolean } {
  const [shown, setShown] = useState(step)
  useEffect(() => {
    if (step === shown) return
    const timer = window.setTimeout(() => setShown(step), MORPH_OUT_MS)
    return () => window.clearTimeout(timer)
  }, [step, shown])
  return { shown, morphing: step !== shown }
}
