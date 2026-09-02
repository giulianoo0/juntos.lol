import { describe, expect, it } from 'vitest'
import { FILE_UNREADABLE, SOURCE_UNREACHABLE, WORKER_UNREACHABLE, readFailureCode } from './uploadErrors'

describe('readFailureCode', () => {
  const unreachable = () => Object.assign(new Error('origin unreachable'), { name: 'ReadUnreachableError' })

  it('blames the worker when a torrent read stops answering', () => {
    expect(readFailureCode(unreachable(), 'worker')).toBe(WORKER_UNREACHABLE)
  })

  it('blames the origin when a plugin url stops answering', () => {
    expect(readFailureCode(unreachable(), 'url')).toBe(SOURCE_UNREACHABLE)
  })

  it('recognises a read failure rebuilt by a worker postMessage', () => {
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
    expect(readFailureCode(new Error('no video track'), 'worker')).toBeNull()
  })
})
