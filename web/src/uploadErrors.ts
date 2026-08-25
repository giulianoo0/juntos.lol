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
