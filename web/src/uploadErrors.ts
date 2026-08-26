// The errors a transfer reports by name, because each has its own remedy and
// the room page says a different thing for each. In their own module so the
// remux worker can classify without dragging the page's upload registry in.

// A file that changed on disk: wait for the download to finish, pick again.
export const FILE_UNREADABLE = 'file-unreadable'
// A container or codec the remuxer cannot take apart.
export const UNSUPPORTED_MEDIA = 'unsupported-media'
// A url this browser cannot even read (CORS, no Range, gone).
export const SOURCE_UNREACHABLE = 'source-unreachable'
// The torrent origin stopped answering, or refused this file for good.
export const WORKER_UNREACHABLE = 'worker-unreachable'

// A read that failed because the underlying file moved under the reader —
// browsers surface it under a handful of names depending on the API used.
export function isUnreadableFile(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'NotReadableError' || error.name === 'NotFoundError'
  }
  if (!(error instanceof Error)) return false
  // A worker's postMessage rebuilds errors as plain Errors; the name is what
  // survives the crossing.
  if (error.name === 'NotReadableError' || error.name === 'NotFoundError') return true
  return error.message === FILE_UNREADABLE
}

// The read failures rangeRead raises when the bytes stop coming. Matched by
// name for the same reason as above, and because the planner wraps whatever
// it caught rather than re-raising it.
export function isUnreachableRead(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'ReadUnreachableError' || error.name === 'ReadFailedError'
}

/**
 * The code for a failure that is about reading the source rather than about
 * the media, or null when it is neither. Both preparo paths — the worker and
 * the page thread it falls back to — name a failure through here, so a source
 * that stopped answering says the same thing whichever one was running.
 */
export function readFailureCode(failure: unknown, kind: string): string | null {
  if (isUnreadableFile(failure)) return FILE_UNREADABLE
  if (isUnreachableRead(failure)) return kind === 'url' ? SOURCE_UNREACHABLE : WORKER_UNREACHABLE
  return null
}
