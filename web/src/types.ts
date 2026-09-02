export interface TrackInfo {
  index: number
  language: string
  title: string
  codec: string
  digest?: string
}

export interface SubtitleFont {
  name: string
  file: string
  size: number
}

export interface PlayState {
  playing: boolean
  positionMs: number
  rate: number
  serverTimeMs: number
}

export interface Member {
  id: string
  nickname: string
  joinedAt: string
}

export interface ChatMessage {
  author: string
  text: string
  at: string
}

export interface PresenceEvent {
  id: number
  memberId: string
  nickname: string
  kind: 'join' | 'leave'
  at: string
}

// `from` is filled in by the server; `id` is client-side, for React keys.
export interface TitleRequest {
  id: number
  memberId: string
  from: string
  metaId: string
  metaType: 'movie' | 'series'
  name: string
  poster: string
  season?: number
  episode?: number
  at: string
}

export interface MemberReadiness {
  memberId: string
  bufferAheadMs: number
  stalled?: boolean
  ready: boolean
  ignored?: boolean
}

// What a publish moved, carried inside the roomUpdated that announces it.
export interface MediaSnapshot {
  mediaGeneration: number
  mediaVersion: number
  mediaOffsetMs: number
  mediaRegions: MediaRegion[] | null
}

export interface RoomWaiting {
  targetMs: number
  readiness: MemberReadiness[]
}

// Either a message someone sent or a presence note the client synthesized.
export interface ChatEntry {
  author: string
  text: string
  at: string
  system?: boolean
}

// How far the room is from being playable, as the server sees it.
export interface RoomPreparation {
  sourceBytes?: number
  receivedBytes?: number
  previewPhase?: 'receiving' | 'probing' | 'segmenting' | 'unavailable'
  previewTargetBytes?: number
  swarm?: { peers: number; downSpeed: number; haveBytes: number; selectedBytes: number; diskBytes?: number }
}

export interface RoomChapter {
  startMs: number
  endMs: number
  title?: string
}

export interface MediaRegion {
  n: number
  startMs: number
  producedMs: number
  growing: boolean
}

export interface RoomInfo {
  id: string
  fileName: string
  status: string
  sourceKind: 'upload' | 'screen'
  sourceMemberId?: string
  sourceOrigin?: 'file' | 'torrent' | 'url'
  mediaGeneration: number
  mediaVersion?: number
  subsVersion?: number
  durationMs?: number
  mediaOffsetMs?: number
  mediaRegions?: MediaRegion[]
  gatingEnabled?: boolean
  errorMessage?: string
  controllerId: string
  audioTracks: TrackInfo[] | null
  subtitleTracks: TrackInfo[] | null
  subtitleFonts?: SubtitleFont[] | null
  chapters?: RoomChapter[] | null
  bitmapSubsSkipped: number
  producerHeartbeatMs?: number
  preparation?: RoomPreparation
  memberCount: number
  expiresAt: string
  mediaBaseUrl?: string
}
