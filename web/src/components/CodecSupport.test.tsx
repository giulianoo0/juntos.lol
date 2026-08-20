import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodecSupportNotice } from './CodecSupport'

// The component asks the browser through MediaSource, which jsdom does not
// have. Standing one up is what lets each of these describe a real browser.
function browserPlaying(codecs: { hevc: boolean; av1: boolean; h264?: boolean }) {
  vi.stubGlobal('MediaSource', {
    isTypeSupported: (mimeType: string) => {
      if (mimeType.includes('hvc1')) return codecs.hevc
      if (mimeType.includes('av01')) return codecs.av1
      return codecs.h264 ?? true
    },
  })
}

describe('CodecSupportNotice', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('says nothing to a browser that plays everything', () => {
    browserPlaying({ hevc: true, av1: true })

    render(<CodecSupportNotice />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('lists every codec, marking the ones that will not play', () => {
    browserPlaying({ hevc: false, av1: true })

    render(<CodecSupportNotice />)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // All three are named, so the answer is a report rather than only a
    // complaint — the working ones are the reassuring half.
    expect(screen.getByText('H.264 / AVC')).toBeInTheDocument()
    expect(screen.getByText('HEVC / H.265')).toBeInTheDocument()
    expect(screen.getByText('AV1')).toBeInTheDocument()
    // Anchored: unanchored, the row's own text contains the pill's and each
    // status would be found twice.
    expect(screen.getAllByText(/^(will not play|não reproduz)$/i)).toHaveLength(1)
    expect(screen.getAllByText(/^(plays|reproduz)$/i)).toHaveLength(2)
  })

  it('stays shut once dismissed', () => {
    browserPlaying({ hevc: false, av1: false })
    const { unmount } = render(<CodecSupportNotice />)
    fireEvent.click(screen.getByRole('button', { name: /got it|entendi/i }))
    unmount()

    render(<CodecSupportNotice />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // A dismissal is about one answer. Carrying it to a browser that cannot play
  // something else would silence the warning exactly where it matters.
  it('warns again when the browser gives a different answer', () => {
    browserPlaying({ hevc: false, av1: true })
    const { unmount } = render(<CodecSupportNotice />)
    fireEvent.click(screen.getByRole('button', { name: /got it|entendi/i }))
    unmount()

    browserPlaying({ hevc: false, av1: false })
    render(<CodecSupportNotice />)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('claims nothing when the browser offers no way to ask', () => {
    vi.stubGlobal('MediaSource', undefined)
    const video = document.createElement('video')
    vi.spyOn(document, 'createElement').mockReturnValue(
      Object.assign(video, { canPlayType: undefined }) as HTMLVideoElement,
    )

    render(<CodecSupportNotice />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    vi.restoreAllMocks()
  })
})
