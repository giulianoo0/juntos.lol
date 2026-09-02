import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CopyErrorReport } from './CopyErrorReport'
import type { RoomInfo } from '../types'

const room = {
  id: 'r1',
  fileName: 'movie.mkv',
  status: 'uploading',
  sourceKind: 'upload',
  mediaGeneration: 0,
  mediaVersion: 0,
  durationMs: 0,
  controllerId: 'c',
  audioTracks: null,
  subtitleTracks: null,
  bitmapSubsSkipped: 0,
  memberCount: 1,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  preparation: { swarm: { peers: 5, downSpeed: 1000, haveBytes: 10, selectedBytes: 100 } },
} as RoomInfo

const t = ((key: string) => key) as unknown as Parameters<typeof CopyErrorReport>[0]['t']

describe('CopyErrorReport', () => {
  let copied = ''
  beforeEach(() => {
    copied = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copied = text } },
    })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('carries the reason the pipeline gave, which is the part nobody else has', async () => {
    render(<CopyErrorReport room={room} failure="unsupported_media" detail="video codec hevc cannot be copied" t={t} />)
    await userEvent.click(screen.getByRole('button'))

    expect(copied).toContain('video codec hevc cannot be copied')
    expect(copied).toContain('unsupported_media')
    expect(copied).toContain('movie.mkv')
    expect(copied).toContain('5 peers')
    expect(copied).toContain('not available in this browser')
    expect(await screen.findByText('room.copyReportDone')).toBeTruthy()
  })

  it('asks the browser which codecs it decodes, when it can be asked', async () => {
    const asked: string[] = []
    vi.stubGlobal('VideoDecoder', {
      isConfigSupported: async (config: { codec: string }) => {
        asked.push(config.codec)
        return { supported: config.codec.startsWith('avc1') }
      },
    })
    vi.stubGlobal('AudioDecoder', { isConfigSupported: async () => ({ supported: true }) })
    vi.stubGlobal('AudioEncoder', { isConfigSupported: async () => ({ supported: false }) })

    render(<CopyErrorReport room={room} failure="unsupported_media" detail="x" t={t} />)
    await userEvent.click(screen.getByRole('button'))

    expect(asked).toContain('avc1.640028')
    expect(copied).toContain('H.264 (avc1.640028): decodes')
    expect(copied).toContain('HEVC (hvc1.1.6.L93.B0): no')
    expect(copied).toContain('AAC encode (required for every non-AAC track): no')
    vi.unstubAllGlobals()
  })

  it('says so plainly when the pipeline gave no reason', async () => {
    render(<CopyErrorReport room={room} failure="unsupported_media" detail={null} t={t} />)
    await userEvent.click(screen.getByRole('button'))
    expect(copied).toContain('the pipeline gave no reason')
  })

  it('keeps the report when the clipboard refuses', async () => {
    const logged: unknown[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args[0]) })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('denied') } },
    })
    render(<CopyErrorReport room={room} failure="unsupported_media" detail="nope" t={t} />)
    await userEvent.click(screen.getByRole('button'))

    expect(await screen.findByText('room.copyReportFailed')).toBeTruthy()
    expect(String(logged[0])).toContain('nope')
  })
})
