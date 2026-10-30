import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSoundChoice, modeFor, resetSoundChoiceForTests, setAppMuted, setSoundEnabled } from './soundChoice'

const calls: { url: string; body: unknown }[] = []

beforeEach(() => {
  calls.length = 0
  resetSoundChoiceForTests()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response('{}', { status: 200 })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('soundChoice', () => {
  it('starts with Discord muted, so the call does not echo back', () => {
    expect(getSoundChoice()).toEqual({ enabled: true, muted: ['discord'] })
    expect(modeFor(getSoundChoice())).toBe('custom')
  })

  it('leaving an app out switches the app to custom and mutes it there', () => {
    setAppMuted('discord', false)
    calls.length = 0
    setAppMuted('spotify', true)
    expect(getSoundChoice().muted).toEqual(['spotify'])
    expect(calls.map((call) => call.body)).toEqual([{ mode: 'custom' }, { app: 'spotify', muted: true }])
  })

  it('bringing the last app back returns to the whole mix and unmutes it', () => {
    setAppMuted('discord', false)
    calls.length = 0
    expect(getSoundChoice().muted).toEqual([])
    setAppMuted('spotify', true)
    calls.length = 0
    setAppMuted('spotify', false)
    expect(getSoundChoice().muted).toEqual([])
    expect(calls.map((call) => call.body)).toEqual([{ app: 'spotify', muted: false }, { mode: 'all' }])
  })

  it('switching sound off is none, and the mutes survive for when it comes back', () => {
    setAppMuted('spotify', true)
    setSoundEnabled(false)
    expect(modeFor(getSoundChoice())).toBe('none')
    expect(calls.map((call) => call.body)).toContainEqual({ mode: 'none' })
    setSoundEnabled(true)
    expect(modeFor(getSoundChoice())).toBe('custom')
  })
})
