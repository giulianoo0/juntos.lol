import { describe, expect, it } from 'vitest'
import type { RoomInfo } from '../types'
import {
  GRANT_TTL_MS,
  canCloseStage,
  canDriveMedia,
  canOpenStage,
  hasMedia,
  initialStages,
  spotlightStage,
  stagesOf,
  stagesReducer,
  type StagesState,
} from './stages'

function room(patch: Partial<RoomInfo> = {}): RoomInfo {
  return {
    id: 'R1',
    fileName: '',
    status: 'empty',
    controllerId: 'm1',
    audioTracks: null,
    subtitleTracks: null,
    bitmapSubsSkipped: 0,
    mediaGeneration: 0,
    memberCount: 2,
    expiresAt: '',
    ...patch,
  }
}

describe('stagesOf', () => {
  it('finds no stage in a room born empty', () => {
    expect(stagesOf(room())).toEqual([])
    expect(hasMedia(room())).toBe(false)
  })

  it('lists the media, the live and every screen side by side, in that order', () => {
    const stages = stagesOf(room({
      status: 'ready',
      fileName: 'filme.mkv',
      sourceMemberId: 'm2',
      live: { videoId: 'v', title: 'Rádio', producer: 'fleet', broadcast: 'juntos/R1/s/live.hang', memberId: 'm1', status: 'ready' },
      screens: [
        { memberId: 'm3', nickname: 'ana', since: '2026-10-26T10:00:01Z' },
        { memberId: 'm1', nickname: 'giuli', since: '2026-10-26T10:00:00Z' },
      ],
    }))
    expect(stages.map((stage) => stage.id)).toEqual(['media', 'live', 'screen:m1', 'screen:m3'])
    expect(stages[0]).toMatchObject({ kind: 'media', ownerId: 'm2', title: 'filme.mkv', status: 'ready' })
    expect(stages[1]).toMatchObject({ kind: 'live', ownerId: 'm1', title: 'Rádio', status: 'ready', broadcast: 'juntos/R1/s/live.hang' })
    expect(stages[3]).toMatchObject({ kind: 'screen', ownerId: 'm3', title: 'ana' })
  })

  it('counts a media that failed or is still arriving as a stage', () => {
    expect(stagesOf(room({ status: 'uploading', fileName: 'a.mkv' }))[0]).toMatchObject({ kind: 'media', status: 'uploading' })
    expect(stagesOf(room({ status: 'error', errorMessage: 'x' }))[0]).toMatchObject({ kind: 'media', status: 'error', error: 'x' })
  })
})

describe('who may do what', () => {
  const playing = room({ status: 'ready', sourceMemberId: 'm2', screens: [{ memberId: 'm3', nickname: 'ana', since: '' }] })

  it('lets the host and whoever opened the media drive it', () => {
    expect(canDriveMedia(playing, 'm1')).toBe(true)
    expect(canDriveMedia(playing, 'm2')).toBe(true)
    expect(canDriveMedia(playing, 'm3')).toBe(false)
    expect(canDriveMedia(playing, '')).toBe(false)
  })

  it('lets the host or the owner close a stage', () => {
    const [media, screen] = stagesOf(playing)
    expect(canCloseStage(playing, media, 'm1')).toBe(true)
    expect(canCloseStage(playing, media, 'm2')).toBe(true)
    expect(canCloseStage(playing, screen, 'm3')).toBe(true)
    expect(canCloseStage(playing, screen, 'm2')).toBe(false)
  })

  it('lets a guest open a stage only with a grant that has not run out', () => {
    const now = 1_000_000
    let state = stagesReducer(initialStages, { type: 'stageGrant', kind: 'screen', allow: true, at: now })
    expect(canOpenStage(playing, state, 'm4', 'screen', now)).toBe(true)
    expect(canOpenStage(playing, state, 'm4', 'media', now)).toBe(false)
    expect(canOpenStage(playing, state, 'm4', 'screen', now + GRANT_TTL_MS)).toBe(false)
    expect(canOpenStage(playing, initialStages, 'm1', 'live', now)).toBe(true)
    state = stagesReducer(state, { type: 'used', kind: 'screen' })
    expect(canOpenStage(playing, state, 'm4', 'screen', now)).toBe(false)
  })
})

describe('stagesReducer', () => {
  it('keeps the host an inbox of requests, without repeats, until each is answered', () => {
    let state: StagesState = initialStages
    const ask = { type: 'stageRequest', requestId: 'q1', memberId: 'm2', nickname: 'ana', kind: 'screen' } as const
    state = stagesReducer(state, ask)
    state = stagesReducer(state, ask)
    state = stagesReducer(state, { ...ask, requestId: 'q2', kind: 'media' })
    expect(state.requests.map((request) => request.requestId)).toEqual(['q1', 'q2'])
    state = stagesReducer(state, { type: 'answered', requestId: 'q1' })
    expect(state.requests.map((request) => request.requestId)).toEqual(['q2'])
  })

  it('drops the requests of whoever left', () => {
    let state = stagesReducer(initialStages, { type: 'stageRequest', requestId: 'q1', memberId: 'm2', nickname: 'ana', kind: 'screen' })
    state = stagesReducer(state, { type: 'members', ids: ['m1', 'm3'] })
    expect(state.requests).toEqual([])
  })

  it('follows a guest from asking to the answer', () => {
    let state = stagesReducer(initialStages, { type: 'asked', kind: 'screen' })
    expect(state.asked).toEqual(['screen'])
    state = stagesReducer(state, { type: 'stageGrant', kind: 'screen', allow: false, at: 5 })
    expect(state.asked).toEqual([])
    expect(state.granted.screen).toBeUndefined()
    expect(state.answer).toEqual({ kind: 'screen', allow: false, seq: 1 })

    state = stagesReducer(state, { type: 'asked', kind: 'screen' })
    state = stagesReducer(state, { type: 'stageGrant', kind: 'screen', allow: true, at: 9 })
    expect(state.granted.screen).toBe(9)
    expect(state.answer).toEqual({ kind: 'screen', allow: true, seq: 2 })
  })

  it('takes a grant back when the host closes that stage', () => {
    let state = stagesReducer(initialStages, { type: 'stageGrant', kind: 'screen', allow: true, at: 1 })
    state = stagesReducer(state, { type: 'stageClosed', kind: 'screen' })
    expect(state.granted.screen).toBeUndefined()
    expect(state.closed).toEqual({ kind: 'screen', seq: 1 })
  })

  it('remembers the spotlight the host sets and clears', () => {
    let state = stagesReducer(initialStages, { type: 'spotlight', spotlight: { kind: 'screen', memberId: 'm3' } })
    expect(state.spotlight).toEqual({ kind: 'screen', memberId: 'm3' })
    state = stagesReducer(state, { type: 'spotlight', spotlight: null })
    expect(state.spotlight).toBeNull()
  })
})

describe('spotlightStage', () => {
  const full = room({
    status: 'ready',
    live: { videoId: 'v', title: 't', producer: 'fleet', broadcast: 'b' },
    screens: [{ memberId: 'm3', nickname: 'ana', since: '' }],
    spotlight: { kind: 'live' },
  })

  it('points at the stage the host put forward, from the room until a message says otherwise', () => {
    expect(spotlightStage(full, initialStages)?.id).toBe('live')
    const moved = stagesReducer(initialStages, { type: 'spotlight', spotlight: { kind: 'screen', memberId: 'm3' } })
    expect(spotlightStage(full, moved)?.id).toBe('screen:m3')
    const cleared = stagesReducer(initialStages, { type: 'spotlight', spotlight: null })
    expect(spotlightStage(full, cleared)).toBeNull()
  })

  it('ignores a spotlight on a stage that is gone or on a member', () => {
    const gone = stagesReducer(initialStages, { type: 'spotlight', spotlight: { kind: 'screen', memberId: 'm9' } })
    expect(spotlightStage(full, gone)).toBeNull()
    const person = stagesReducer(initialStages, { type: 'spotlight', spotlight: { kind: 'member', memberId: 'm3' } })
    expect(spotlightStage(full, person)).toBeNull()
  })
})
