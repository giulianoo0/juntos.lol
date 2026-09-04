import { afterEach, describe, expect, it, vi } from 'vitest'

function fakeAudioContext(state: AudioContextState) {
  const oscillator = {
    type: 'sine', frequency: { value: 0 },
    connect: vi.fn(() => ({ connect: vi.fn() })), start: vi.fn(), stop: vi.fn(),
  }
  const gain = { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } }
  const ctx = {
    state, currentTime: 0, destination: {},
    resume: vi.fn(() => Promise.resolve()),
    createOscillator: vi.fn(() => oscillator),
    createGain: vi.fn(() => gain),
  }
  return { ctx, oscillator }
}

describe('chime', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('plays one note for a message once audio is running', async () => {
    const { ctx, oscillator } = fakeAudioContext('running')
    vi.stubGlobal('AudioContext', function FakeAudioContext() { return ctx })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const { playMessageChime } = await import('./chime')
    playMessageChime()
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1)
    expect(oscillator.frequency.value).toBe(880)
    expect(oscillator.start).toHaveBeenCalled()
  })

  it('only wakes the context before a gesture has unlocked audio', async () => {
    const { ctx } = fakeAudioContext('suspended')
    vi.stubGlobal('AudioContext', function FakeAudioContext() { return ctx })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const { playMessageChime } = await import('./chime')
    playMessageChime()
    expect(ctx.resume).toHaveBeenCalled()
    expect(ctx.createOscillator).not.toHaveBeenCalled()
  })

  it('stays silent for a reader who asked for reduced motion', async () => {
    const { ctx } = fakeAudioContext('running')
    vi.stubGlobal('AudioContext', function FakeAudioContext() { return ctx })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const { playJoinChime } = await import('./chime')
    playJoinChime()
    expect(ctx.createOscillator).not.toHaveBeenCalled()
  })
})
