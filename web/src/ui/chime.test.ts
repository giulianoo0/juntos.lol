import { afterEach, describe, expect, it, vi } from 'vitest'

function fakeAudioContext(state: AudioContextState, resume: () => Promise<void> = () => Promise.resolve()) {
  const source = { buffer: null as unknown, connect: vi.fn(() => ({ connect: vi.fn() })), start: vi.fn() }
  const ctx = {
    state, destination: {},
    resume: vi.fn(resume),
    decodeAudioData: vi.fn(async () => ({ decoded: true })),
    createBufferSource: vi.fn(() => source),
    createGain: vi.fn(() => ({ gain: { value: 0 } })),
  }
  return { ctx, source }
}

function stub(ctx: unknown, reduced = false) {
  const fetch = vi.fn(async () => new Response(new ArrayBuffer(4)))
  vi.stubGlobal('AudioContext', function FakeAudioContext() { return ctx })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced })))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('chime', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('plays the message sound once audio is running', async () => {
    const { ctx, source } = fakeAudioContext('running')
    const fetch = stub(ctx)
    const { playMessageChime } = await import('./chime')
    playMessageChime()
    await settle()
    expect(fetch).toHaveBeenCalledWith('/sounds/chatEditModifiedFile.mp3')
    expect(source.start).toHaveBeenCalledTimes(1)
  })

  it('plays each arrival and departure with its own sound', async () => {
    const { ctx } = fakeAudioContext('running')
    const fetch = stub(ctx)
    const { playJoinChime, playLeaveChime } = await import('./chime')
    playJoinChime()
    playLeaveChime()
    await settle()
    expect(fetch).toHaveBeenCalledWith('/sounds/voiceRecordingStarted.mp3')
    expect(fetch).toHaveBeenCalledWith('/sounds/voiceRecordingStopped.mp3')
  })

  it('plays a burst of the same sound once', async () => {
    const { ctx, source } = fakeAudioContext('running')
    stub(ctx)
    const { playJoinChime } = await import('./chime')
    playJoinChime()
    playJoinChime()
    playJoinChime()
    await settle()
    expect(source.start).toHaveBeenCalledTimes(1)
  })

  it('stays silent while audio waits for a gesture', async () => {
    const { ctx, source } = fakeAudioContext('suspended', () => new Promise(() => {}))
    stub(ctx)
    const { playMessageChime } = await import('./chime')
    playMessageChime()
    await settle()
    expect(ctx.resume).toHaveBeenCalled()
    expect(source.start).not.toHaveBeenCalled()
  })

  it('stays silent for a reader who asked for reduced motion', async () => {
    const { ctx, source } = fakeAudioContext('running')
    stub(ctx, true)
    const { playJoinChime } = await import('./chime')
    playJoinChime()
    await settle()
    expect(source.start).not.toHaveBeenCalled()
  })
})
