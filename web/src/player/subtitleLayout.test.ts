import { describe, expect, it } from 'vitest'

import { subtitleFontSize, videoContentRect } from './subtitleLayout'

describe('videoContentRect', () => {
  it('fills the element when the ratios match', () => {
    expect(videoContentRect({ clientWidth: 1600, clientHeight: 900, videoWidth: 1920, videoHeight: 1080 }))
      .toEqual({ left: 0, top: 0, width: 1600, height: 900 })
  })

  it('finds the picture between horizontal bars', () => {
    const rect = videoContentRect({ clientWidth: 800, clientHeight: 600, videoWidth: 1920, videoHeight: 1080 })
    expect(rect.width).toBe(800)
    expect(rect.height).toBe(450)
    expect(rect.top).toBe(75)
    expect(rect.left).toBe(0)
  })

  it('finds the picture between vertical bars', () => {
    const rect = videoContentRect({ clientWidth: 1000, clientHeight: 400, videoWidth: 1920, videoHeight: 1080 })
    expect(rect.height).toBe(400)
    expect(Math.round(rect.width)).toBe(711)
    expect(rect.top).toBe(0)
    expect(Math.round(rect.left)).toBe(144)
  })

  it('falls back to the element before metadata arrives', () => {
    expect(videoContentRect({ clientWidth: 640, clientHeight: 360, videoWidth: 0, videoHeight: 0 }))
      .toEqual({ left: 0, top: 0, width: 640, height: 360 })
  })
})

describe('subtitleFontSize', () => {
  it('scales with the picture', () => {
    expect(subtitleFontSize(1080)).toBe(49)
    expect(subtitleFontSize(360)).toBe(16)
  })

  it('keeps a floor so a small player stays legible', () => {
    expect(subtitleFontSize(100)).toBe(13)
    expect(subtitleFontSize(0)).toBe(13)
  })
})
