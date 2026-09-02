import { describe, expect, it } from 'vitest'
import {
  detectCodecSupport, dismissalRecord, dismissedCodecs, unacknowledgedCodecs, unsupportedCodecs,
  CODEC_PROBES,
} from './codecs'

describe('codec support', () => {
  it('reports every codec the browser accepts', () => {
    const support = detectCodecSupport(() => true)

    expect(support.map((codec) => codec.id)).toEqual(['h264', 'hevc', 'av1', 'vp9'])
    expect(support.every((codec) => codec.supported)).toBe(true)
    expect(unsupportedCodecs(support)).toEqual([])
  })

  it('reports a codec unsupported when the browser refuses it', () => {
    const support = detectCodecSupport((mimeType) => !mimeType.includes('hvc1'))

    expect(support.find((codec) => codec.id === 'hevc')?.supported).toBe(false)
    expect(support.find((codec) => codec.id === 'h264')?.supported).toBe(true)
    expect(unsupportedCodecs(support).map((codec) => codec.id)).toEqual(['hevc'])
  })

  it('holds a codec to every variant it is probed with', () => {
    const tenBit = CODEC_PROBES.find((probe) => probe.id === 'hevc')!.mimeTypes
      .find((mimeType) => mimeType.includes('hvc1.2'))!

    const support = detectCodecSupport((mimeType) => mimeType !== tenBit)

    expect(support.find((codec) => codec.id === 'hevc')?.supported).toBe(false)
  })

  it('claims nothing when there is no way to ask', () => {
    const support = detectCodecSupport(null)

    expect(support.every((codec) => codec.supported)).toBe(true)
    expect(unsupportedCodecs(support)).toEqual([])
  })

  it('holds back only the codecs a dismissal already named', () => {
    const support = detectCodecSupport((mimeType) => mimeType.includes('avc1'))

    expect(unacknowledgedCodecs(support, dismissedCodecs('')).map((codec) => codec.id))
      .toEqual(['hevc', 'av1', 'vp9'])
    expect(unacknowledgedCodecs(support, dismissedCodecs('hevc')).map((codec) => codec.id))
      .toEqual(['av1', 'vp9'])
    expect(unacknowledgedCodecs(support, dismissedCodecs('hevc,av1')).map((codec) => codec.id))
      .toEqual(['vp9'])
    expect(unacknowledgedCodecs(support, dismissedCodecs('hevc,av1,vp9'))).toEqual([])
  })

  it('keeps every codec it has already reported', () => {
    const noHevc = detectCodecSupport((mimeType) => !mimeType.includes('hvc1'))
    const noAv1 = detectCodecSupport((mimeType) => !mimeType.includes('av01'))

    expect(dismissalRecord('', noHevc)).toBe('hevc')
    expect(dismissalRecord('hevc', noAv1)).toBe('hevc,av1')
    expect(dismissalRecord('hevc,av1', detectCodecSupport(() => true))).toBe('hevc,av1')
  })

  it('reads a dismissal stored in the old whole-answer form', () => {
    expect([...dismissedCodecs('h264:1,hevc:0,av1:1')]).toEqual(['hevc'])
    expect([...dismissedCodecs('h264:1,hevc:1,av1:1')]).toEqual([])
    expect([...dismissedCodecs('')]).toEqual([])
    expect([...dismissedCodecs('vp8,hevc')]).toEqual(['hevc'])
  })
})
