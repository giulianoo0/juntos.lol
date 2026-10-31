/**
 * The details panel, loaded on demand: the heaviest thing behind the board and
 * never on screen at first draw. Warmed once the board is idle, so the morph
 * out of the poster still starts on the click's frame.
 */
import { lazy } from 'react'

const load = () => import('./MetaDetails')

export const MetaDetails = lazy(() => load().then((module) => ({ default: module.MetaDetails })))

export function prefetchMetaDetails(): void {
  void load().catch(() => undefined)
}
