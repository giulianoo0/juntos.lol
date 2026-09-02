/// <reference lib="webworker" />
/**
 * The subtitle scan's thread. The page posts one job; the walk over the
 * torrent and every publish happen here, away from the player.
 */
import { runSubtitleScan, type SubtitleScanJob } from './subtitleScan'
import { ReadAbortedError } from './rangeRead'

export type SubtitleWorkerToPage =
  | { type: 'done' }
  | { type: 'failed'; detail: string }
  | { type: 'trouble'; detail: string }

export type PageToSubtitleWorker = { type: 'start'; job: SubtitleScanJob }

const post = (message: SubtitleWorkerToPage) => { self.postMessage(message) }

self.addEventListener('unhandledrejection', (event) => {
  const reason = (event as PromiseRejectionEvent).reason as unknown
  if (reason instanceof ReadAbortedError || (reason instanceof Error && reason.name === 'ReadAbortedError')) {
    event.preventDefault()
    return
  }
  post({ type: 'trouble', detail: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason) })
})

self.onmessage = (event: MessageEvent<PageToSubtitleWorker>) => {
  const message = event.data
  if (message.type !== 'start') return
  void runSubtitleScan(message.job)
    .then(() => post({ type: 'done' }))
    .catch((error: unknown) => {
      post({ type: 'failed', detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
    })
}
