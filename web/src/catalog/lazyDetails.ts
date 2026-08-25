/**
 * The details panel, loaded on demand.
 *
 * It is the heaviest thing behind the board — the season carousel, the stream
 * list, the morph — and it is never on screen when the catalog first draws.
 * The chunk is warmed as soon as the board is idle, well before anyone can
 * read a row and pick a title, so the morph out of the poster still starts on
 * the same frame as the click.
 */
import { lazy } from 'react'

const load = () => import('./MetaDetails')

export const MetaDetails = lazy(() => load().then((module) => ({ default: module.MetaDetails })))

export function prefetchMetaDetails(): void {
  void load().catch(() => undefined)
}
