/// <reference lib="webworker" />
/**
 * The remux job's thread. The page posts one job and forwards the room's
 * playhead; everything heavy — demux, mux, uploads, subtitle extraction —
 * happens here, and the page's main thread stays with the player.
 */
import { PlanFailedError, runRemuxJob, runSubtitleJob, UnsupportedMediaError, type RemuxJob } from './remuxJob'
import { RoomMovedOnError, type ClientRemuxHandle } from './clientMedia'
import { SOURCE_UNREACHABLE, UNSUPPORTED_MEDIA, readFailureCode } from '../uploadErrors'
import { ReadAbortedError } from './rangeRead'
import type { SeekTrace } from './seekTrace'

export type WorkerToPage =
  | { type: 'progress'; pct: number }
  | { type: 'handle' }
  | { type: 'done' }
  | { type: 'moved-on' }
  | { type: 'failed'; code: string; detail?: string }
  | { type: 'trouble'; detail: string }
  | { type: 'trace'; trace: SeekTrace }

export type PageToWorker =
  | { type: 'start'; job: RemuxJob }
  | { type: 'follow'; absoluteMs: number }

const post = (message: WorkerToPage) => { self.postMessage(message) }

// Surfaced on the page's console: a worker's own console is easy to never
// look at, and a silent death here is a room that quietly stops preparing.
self.addEventListener('unhandledrejection', (event) => {
  const reason = (event as PromiseRejectionEvent).reason as unknown
  // A seek aborts the reads of the region it left; mediabunny's prefetch
  // workers surface that as a rejection nobody awaits. Expected, not
  // trouble. Matched by name: the error may have crossed a bundle seam.
  if (reason instanceof ReadAbortedError || (reason instanceof Error && reason.name === 'ReadAbortedError')) {
    event.preventDefault()
    return
  }
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
  if (message.job.subtitlesOnly) {
    void runSubtitleJob(message.job)
      .then(() => post({ type: 'done' }))
      .catch((error: unknown) => {
        console.error('subtitle scan failed', error)
        post({ type: 'failed', code: classify(error, message.job.source.kind), detail: describe(error) })
      })
    return
  }
  void runRemuxJob(message.job, {
    onProgress: (pct) => post({ type: 'progress', pct }),
    onTrace: (trace) => post({ type: 'trace', trace }),
    onHandle: (next) => {
      handle = next
      if (pendingFollowMs !== null) next.follow(pendingFollowMs)
      post({ type: 'handle' })
    },
  }).then(() => post({ type: 'done' })).catch((error: unknown) => {
    if (error instanceof RoomMovedOnError) { post({ type: 'moved-on' }); return }
    console.error('client media pipeline failed', error)
    post({ type: 'failed', code: classify(error, message.job.source.kind), detail: describe(error) })
  })
}

// The error in words, for the report the page can hand to a person. The code
// above is what the screen renders; this is what says why.
function describe(error: unknown): string {
  if (error instanceof UnsupportedMediaError && error.reason) return error.reason
  if (error instanceof PlanFailedError) {
    const cause = error.failure
    return cause instanceof Error ? `plan failed: ${cause.name}: ${cause.message}` : `plan failed: ${String(cause)}`
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function classify(error: unknown, kind: RemuxJob['source']['kind']): string {
  if (error instanceof UnsupportedMediaError) return UNSUPPORTED_MEDIA
  // Planning reads the source, so it fails for the source's reasons as often
  // as for the media's. Unwrap it and judge the failure itself: a swarm that
  // stopped answering during the plan is the same unreachable origin it would
  // be a second later during the remux, and telling someone their browser
  // cannot play the file sends them off to fix the wrong thing.
  const failure = error instanceof PlanFailedError ? error.failure : error
  const read = readFailureCode(failure, kind)
  if (read) return read
  // Anything else the planner choked on is the media itself: it read bytes
  // and could not make a container out of them.
  if (error instanceof PlanFailedError) return kind === 'url' ? SOURCE_UNREACHABLE : UNSUPPORTED_MEDIA
  return error instanceof Error ? error.message : 'upload failed'
}
