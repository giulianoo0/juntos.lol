export interface TrackInfo {
  index: number
  language: string
  title: string
  codec: string
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

// A member arriving or leaving, derived by diffing the roster the server
// broadcasts. Rendered both as a transient toast and as a chat entry.
export interface PresenceEvent {
  id: number
  memberId: string
  nickname: string
  kind: 'join' | 'leave'
  at: string
}

// One row of the chat timeline: either a message someone sent or a presence
// note the client synthesized.
export interface ChatEntry {
  author: string
  text: string
  at: string
  system?: boolean
}

export interface RoomInfo {
  id: string
  fileName: string
  status: string
  // What the room is playing. A screen share has no media pipeline behind it.
  sourceKind: 'upload' | 'screen'
  // Increments whenever the controller swaps the source, so the player knows
  // the media behind an unchanged URL is a different recording.
  mediaGeneration: number
  errorMessage?: string
  controllerId: string
  audioTracks: TrackInfo[] | null
  subtitleTracks: TrackInfo[] | null
  bitmapSubsSkipped: number
  memberCount: number
  expiresAt: string
}
