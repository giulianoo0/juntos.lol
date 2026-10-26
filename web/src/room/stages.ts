/**
 * The stages of a room — one media with a timeline, one live, up to four
 * screens — read off the room, and the asking around them: a guest asks the
 * host, the host answers, a yes is a grant the server keeps for ten minutes
 * or until the stage is opened. The host and whoever opened a stage never
 * need one.
 */
import type { RoomInfo, Spotlight, StageKind } from '../types'

/** How long the server keeps a yes waiting to be used. */
export const GRANT_TTL_MS = 10 * 60 * 1000

export interface Stage {
  /** 'media', 'live', or 'screen:{memberId}'. */
  id: string
  kind: StageKind
  /** Who opened it and runs it besides the host; null when nobody is on record. */
  ownerId: string | null
  /** The file, the live's title, or the sharer's nickname. */
  title: string
  /** The media's or the live's progress: uploading, processing, ready, error. Empty for a screen. */
  status: string
  error?: string
  /** Where a live sits on the relay. */
  broadcast?: string
  /** When a screen went up. */
  since?: string
}

export function hasMedia(room: RoomInfo): boolean {
  return room.status !== '' && room.status !== 'empty'
}

export function stagesOf(room: RoomInfo): Stage[] {
  const stages: Stage[] = []
  if (hasMedia(room)) {
    stages.push({
      id: 'media',
      kind: 'media',
      ownerId: room.sourceMemberId || null,
      title: room.fileName,
      status: room.status,
      ...(room.errorMessage ? { error: room.errorMessage } : {}),
    })
  }
  if (room.live) {
    stages.push({
      id: 'live',
      kind: 'live',
      ownerId: room.live.memberId || null,
      title: room.live.title,
      status: room.live.status ?? '',
      broadcast: room.live.broadcast,
      ...(room.live.error ? { error: room.live.error } : {}),
    })
  }
  const screens = [...(room.screens ?? [])].sort((left, right) => (
    left.since === right.since ? left.memberId.localeCompare(right.memberId) : left.since.localeCompare(right.since)
  ))
  for (const screen of screens) {
    stages.push({
      id: `screen:${screen.memberId}`,
      kind: 'screen',
      ownerId: screen.memberId,
      title: screen.nickname,
      status: '',
      since: screen.since,
    })
  }
  return stages
}

/** Play, pause, seek and rate: the host's, and whoever opened the media's. */
export function canDriveMedia(room: RoomInfo, memberId: string): boolean {
  if (!memberId) return false
  return memberId === room.controllerId || (hasMedia(room) && memberId === room.sourceMemberId)
}

export function canCloseStage(room: RoomInfo, stage: Stage, memberId: string): boolean {
  return memberId !== '' && (memberId === room.controllerId || memberId === stage.ownerId)
}

/** Whether this member may open (or replace) a stage of this kind without asking first. */
export function canOpenStage(room: RoomInfo, state: StagesState, memberId: string, kind: StageKind, now = Date.now()): boolean {
  if (!memberId) return false
  if (memberId === room.controllerId) return true
  if (stagesOf(room).some((stage) => stage.kind === kind && stage.ownerId === memberId)) return true
  const at = state.granted[kind]
  return at !== undefined && now - at < GRANT_TTL_MS
}

/** A guest's question waiting in the host's inbox. */
export interface StageRequest {
  requestId: string
  memberId: string
  nickname: string
  kind: StageKind
}

export interface StagesState {
  /** For the host: what guests asked for, oldest first. */
  requests: StageRequest[]
  /** For a guest: what they asked and still wait on. */
  asked: StageKind[]
  /** For a guest: when each yes arrived, until it is used or taken back. */
  granted: Partial<Record<StageKind, number>>
  /** The latest answer this member got; seq tells two equal answers apart. */
  answer: { kind: StageKind; allow: boolean; seq: number } | null
  /** The latest stage of this member's the host closed. */
  closed: { kind: StageKind; seq: number } | null
  /** undefined until the socket says anything: the room's own spotlight holds until then. */
  spotlight: Spotlight | null | undefined
}

export const initialStages: StagesState = {
  requests: [],
  asked: [],
  granted: {},
  answer: null,
  closed: null,
  spotlight: undefined,
}

export type StageEvent =
  | ({ type: 'stageRequest' } & StageRequest)
  | { type: 'answered'; requestId: string }
  | { type: 'asked'; kind: StageKind }
  | { type: 'stageGrant'; kind: StageKind; allow: boolean; at: number }
  | { type: 'used'; kind: StageKind }
  | { type: 'stageClosed'; kind: StageKind }
  | { type: 'spotlight'; spotlight: Spotlight | null }
  | { type: 'members'; ids: string[] }

export function stagesReducer(state: StagesState, event: StageEvent): StagesState {
  switch (event.type) {
    case 'stageRequest': {
      if (state.requests.some((request) => request.requestId === event.requestId)) return state
      const { type: _type, ...request } = event
      return { ...state, requests: [...state.requests, request] }
    }
    case 'answered':
      return { ...state, requests: state.requests.filter((request) => request.requestId !== event.requestId) }
    case 'asked':
      return state.asked.includes(event.kind) ? state : { ...state, asked: [...state.asked, event.kind] }
    case 'stageGrant': {
      const granted = { ...state.granted }
      if (event.allow) granted[event.kind] = event.at
      else delete granted[event.kind]
      return {
        ...state,
        asked: state.asked.filter((kind) => kind !== event.kind),
        granted,
        answer: { kind: event.kind, allow: event.allow, seq: (state.answer?.seq ?? 0) + 1 },
      }
    }
    case 'used':
    case 'stageClosed': {
      const granted = { ...state.granted }
      delete granted[event.kind]
      return event.type === 'used'
        ? { ...state, granted }
        : { ...state, granted, closed: { kind: event.kind, seq: (state.closed?.seq ?? 0) + 1 } }
    }
    case 'spotlight':
      return { ...state, spotlight: event.spotlight }
    case 'members': {
      const present = new Set(event.ids)
      const requests = state.requests.filter((request) => present.has(request.memberId))
      return requests.length === state.requests.length ? state : { ...state, requests }
    }
  }
}

/** The spotlight in force: the latest the socket said, or the room's. */
export function currentSpotlight(room: RoomInfo, state: StagesState): Spotlight | null {
  return state.spotlight === undefined ? room.spotlight ?? null : state.spotlight
}

/** The stage the host put in front of everyone, if it is still up. A member in the spotlight is not a stage. */
export function spotlightStage(room: RoomInfo, state: StagesState): Stage | null {
  const spotlight = currentSpotlight(room, state)
  if (!spotlight || spotlight.kind === 'member') return null
  const id = spotlight.kind === 'screen' ? `screen:${spotlight.memberId ?? ''}` : spotlight.kind
  return stagesOf(room).find((stage) => stage.id === id) ?? null
}
