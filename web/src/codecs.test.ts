import { describe, expect, it } from 'vitest'
import { detectCodecSupport, supportSignature, unsupportedCodecs, CODEC_PROBES } from './codecs'

describe('codec support', () => {
  it('reports every codec the browser accepts', () => {
    const support = detectCodecSupport(() => true)

    expect(support.map((codec) => codec.id)).toEqual(['h264', 'hevc', 'av1'])
    expect(support.every((codec) => codec.supported)).toBe(true)
    expect(unsupportedCodecs(support)).toEqual([])
  })

  it('reports a codec unsupported when the browser refuses it', () => {
    const support = detectCodecSupport((mimeType) => !mimeType.includes('hvc1'))

    expect(support.find((codec) => codec.id === 'hevc')?.supported).toBe(false)
    expect(support.find((codec) => codec.id === 'h264')?.supported).toBe(true)
    expect(unsupportedCodecs(support).map((codec) => codec.id)).toEqual(['hevc'])
  })

  // A browser that decodes 8-bit HEVC but not 10-bit cannot play the releases
  // this app actually sees, so calling that "supported" would cost someone a
  // dead player. Every variant has to pass.
  it('holds a codec to every variant it is probed with', () => {
    const tenBit = CODEC_PROBES.find((probe) => probe.id === 'hevc')!.mimeTypes
      .find((mimeType) => mimeType.includes('hvc1.2'))!

    const support = detectCodecSupport((mimeType) => mimeType !== tenBit)

    expect(support.find((codec) => codec.id === 'hevc')?.supported).toBe(false)
  })

  // Never warn because we could not ask. A browser with neither MediaSource
  // nor canPlayType tells us nothing, and a modal listing everything as broken
  // would be pure noise.
  it('claims nothing when there is no way to ask', () => {
    const support = detectCodecSupport(null)

    expect(support.every((codec) => codec.supported)).toBe(true)
    expect(unsupportedCodecs(support)).toEqual([])
  })

  // The dismissal is remembered against the answer, not against the browser,
  // so the same person on a machine that cannot decode something is warned
  // again rather than silenced by a dismissal they made elsewhere.
  it('signs the result so a different answer warns again', () => {
    const all = detectCodecSupport(() => true)
    const noHevc = detectCodecSupport((mimeType) => !mimeType.includes('hvc1'))

    expect(supportSignature(all)).toBe(supportSignature(detectCodecSupport(() => true)))
    expect(supportSignature(all)).not.toBe(supportSignature(noHevc))
  })
})
