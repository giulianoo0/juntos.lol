import { useEffect, useState } from 'react'

export const MORPH_OUT_MS = 70

/**
 * Holds the rendered step one beat behind the requested one, so the outgoing
 * content has time to dissolve. `morphing` is what the blur hangs off.
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
