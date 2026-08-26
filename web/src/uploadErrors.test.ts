import { describe, expect, it } from 'vitest'
import { FILE_UNREADABLE, SOURCE_UNREACHABLE, WORKER_UNREACHABLE, readFailureCode } from './uploadErrors'

// The failure that started this: a torrent room died showing "unsupported
// media" — go find a different file — when the swarm had simply stopped
// answering mid-plan. The planner reads the source, so it fails for the
// source's reasons, and both preparo paths have to name it the same way.
describe('readFailureCode', () => {
  const unreachable = () => Object.assign(new Error('origin unreachable'), { name: 'ReadUnreachableError' })

  it('blames the worker when a torrent read stops answering', () => {
    expect(readFailureCode(unreachable(), 'worker')).toBe(WORKER_UNREACHABLE)
  })

  it('blames the origin when a plugin url stops answering', () => {
    expect(readFailureCode(unreachable(), 'url')).toBe(SOURCE_UNREACHABLE)
  })

  it('recognises a read failure rebuilt by a worker postMessage', () => {
    // Crossing the thread boundary strips the class and keeps the name.
    const crossed = new Error('no progress after 6 attempts at byte 12')
    crossed.name = 'ReadFailedError'
    expect(readFailureCode(crossed, 'worker')).toBe(WORKER_UNREACHABLE)
  })

  it('blames the file when it moved under the reader', () => {
    const gone = new Error('gone')
    gone.name = 'NotReadableError'
    expect(readFailureCode(gone, 'file')).toBe(FILE_UNREADABLE)
  })

  it('says nothing about a failure that is not a read', () => {
    // A container the demuxer cannot parse is the caller's to name, not ours.
    expect(readFailureCode(new Error('no video track'), 'worker')).toBeNull()
  })
})
