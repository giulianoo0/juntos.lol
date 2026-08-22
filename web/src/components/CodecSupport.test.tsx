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
    expect(screen.getByText('VP9')).toBeInTheDocument()
    // Anchored: unanchored, the row's own text contains the pill's and each
    // status would be found twice.
    expect(screen.getAllByText(/^(will not play|não reproduz)$/i)).toHaveLength(1)
    expect(screen.getAllByText(/^(plays|reproduz)$/i)).toHaveLength(3)
  })

  it('stays shut once dismissed', () => {
    browserPlaying({ hevc: false, av1: false })
    const { unmount } = render(<CodecSupportNotice />)
    fireEvent.click(screen.getByRole('button', { name: /got it|entendi/i }))
    unmount()

    render(<CodecSupportNotice />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // The reported symptom: the notice arriving out of nowhere. Chrome answers
  // for HEVC out of the machine's hardware video decoding, which turns itself
  // off and on — a GPU process that crashed, a driver the blocklist started
  // refusing — so the same browser gives different answers on different days.
  // Gaining a codec back is the browser getting better; there is nothing to
  // say, least of all about a codec the viewer has already been told about.
  it('says nothing when the browser gains a codec back', () => {
    browserPlaying({ hevc: false, av1: false })
    const { unmount } = render(<CodecSupportNotice />)
    fireEvent.click(screen.getByRole('button', { name: /got it|entendi/i }))
    unmount()

    browserPlaying({ hevc: false, av1: true })
    render(<CodecSupportNotice />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // And it must not come back when that codec drops out again, which is the
  // same flap in the other direction.
  it('stays shut when a codec it already reported drops out again', () => {
    browserPlaying({ hevc: false, av1: true })
    const { unmount: first } = render(<CodecSupportNotice />)
    fireEvent.click(screen.getByRole('button', { name: /got it|entendi/i }))
    first()

    browserPlaying({ hevc: true, av1: true })
    const { unmount: second } = render(<CodecSupportNotice />)
    second()

    browserPlaying({ hevc: false, av1: true })
    render(<CodecSupportNotice />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  // A dismissal covers the codecs it named. A codec that was playing and stops
  // is news, and silencing that would lose the warning exactly where it counts.
  it('warns again when a codec it never reported stops playing', () => {
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
