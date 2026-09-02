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

self.addEventListener('unhandledrejection', (event) => {
  const reason = (event as PromiseRejectionEvent).reason as unknown
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
  const failure = error instanceof PlanFailedError ? error.failure : error
  const read = readFailureCode(failure, kind)
  if (read) return read
  if (error instanceof PlanFailedError) return kind === 'url' ? SOURCE_UNREACHABLE : UNSUPPORTED_MEDIA
  return error instanceof Error ? error.message : 'upload failed'
}
