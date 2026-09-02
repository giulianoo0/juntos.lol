// The errors a transfer reports by name, because each has its own remedy and
// the room page says a different thing for each. In their own module so the
// remux worker can classify without dragging the page's upload registry in.

export const FILE_UNREADABLE = 'file-unreadable'
export const UNSUPPORTED_MEDIA = 'unsupported-media'
export const SOURCE_UNREACHABLE = 'source-unreachable'
export const WORKER_UNREACHABLE = 'worker-unreachable'

// Browsers surface a file that moved under the reader under several names.
export function isUnreadableFile(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'NotReadableError' || error.name === 'NotFoundError'
  }
  if (!(error instanceof Error)) return false
  if (error.name === 'NotReadableError' || error.name === 'NotFoundError') return true
  return error.message === FILE_UNREADABLE
}

// Matched by name because the planner wraps what it caught rather than
// re-raising it.
export function isUnreachableRead(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'ReadUnreachableError' || error.name === 'ReadFailedError'
}

/** The code for a failure about reading the source, null when it is not one. */
export function readFailureCode(failure: unknown, kind: string): string | null {
  if (isUnreadableFile(failure)) return FILE_UNREADABLE
  if (isUnreachableRead(failure)) return kind === 'url' ? SOURCE_UNREACHABLE : WORKER_UNREACHABLE
  return null
}

export const REMUX_UNAVAILABLE = 'remux-unavailable'
