/// <reference lib="webworker" />
/**
 * The remux job's thread. The page posts one job and forwards the room's
 * playhead; everything heavy — demux, mux, uploads, subtitle extraction —
 * happens here, and the page's main thread stays with the player.
 */
import { PlanFailedError, runRemuxJob, UnsupportedMediaError, type RemuxJob } from './remuxJob'
import { RoomMovedOnError, type ClientRemuxHandle } from './clientMedia'
import { FILE_UNREADABLE, SOURCE_UNREACHABLE, UNSUPPORTED_MEDIA, WORKER_UNREACHABLE, isUnreadableFile } from '../uploadErrors'
import { ReadAbortedError, ReadFailedError, ReadUnreachableError } from './rangeRead'

export type WorkerToPage =
  | { type: 'progress'; pct: number }
  | { type: 'handle' }
  | { type: 'done' }
  | { type: 'moved-on' }
  | { type: 'failed'; code: string }
  | { type: 'trouble'; detail: string }

export type PageToWorker =
  | { type: 'start'; job: RemuxJob }
  | { type: 'follow'; absoluteMs: number }

const post = (message: WorkerToPage) => { self.postMessage(message) }

// Surfaced on the page's console: a worker's own console is easy to never
// look at, and a silent death here is a room that quietly stops preparing.
self.addEventListener('unhandledrejection', (event) => {
  const reason = (event as PromiseRejectionEvent).reason as unknown
  // A seek aborts the reads of the region it left; mediabunny's prefetch
  // workers surface that as a rejection nobody awaits. Expected, not trouble.
  if (reason instanceof ReadAbortedError) { event.preventDefault(); return }
  console.error('[remux-worker] unhandled rejection', reason)
  post({ type: 'trouble', detail: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason) })
})
self.addEventListener('error', (event) => {
  console.error('[remux-worker] uncaught error', (event as ErrorEvent).message)
  post({ type: 'trouble', detail: (event as ErrorEvent).message })
})

let handle: ClientRemuxHandle | null = null
// A follow that lands before the pipeline's first region is remembered, not
// dropped: it is exactly where the resumed room wants to start.
let pendingFollowMs: number | null = null

self.onmessage = (event: MessageEvent<PageToWorker>) => {
  const message = event.data
  if (message.type === 'follow') {
    if (handle) handle.follow(message.absoluteMs)
    else pendingFollowMs = message.absoluteMs
    return
  }
  if (message.type !== 'start') return
  void runRemuxJob(message.job, {
    onProgress: (pct) => post({ type: 'progress', pct }),
    onHandle: (next) => {
      handle = next
      if (pendingFollowMs !== null) next.follow(pendingFollowMs)
      post({ type: 'handle' })
    },
  }).then(() => post({ type: 'done' })).catch((error: unknown) => {
    if (error instanceof RoomMovedOnError) { post({ type: 'moved-on' }); return }
    console.error('client media pipeline failed', error)
    post({ type: 'failed', code: classify(error, message.job.source.kind) })
  })
}

function classify(error: unknown, kind: RemuxJob['source']['kind']): string {
  if (error instanceof UnsupportedMediaError) return UNSUPPORTED_MEDIA
  if (error instanceof PlanFailedError) {
    if (isUnreadableFile(error.failure)) return FILE_UNREADABLE
    return kind === 'url' ? SOURCE_UNREACHABLE : UNSUPPORTED_MEDIA
  }
  if (isUnreadableFile(error)) return FILE_UNREADABLE
  if (error instanceof ReadUnreachableError || error instanceof ReadFailedError) {
    return kind === 'url' ? SOURCE_UNREACHABLE : WORKER_UNREACHABLE
  }
  return error instanceof Error ? error.message : 'upload failed'
}
