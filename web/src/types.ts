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

export interface RoomInfo {
  id: string
  fileName: string
  status: string
  errorMessage?: string
  controllerId: string
  audioTracks: TrackInfo[] | null
  subtitleTracks: TrackInfo[] | null
  bitmapSubsSkipped: number
  memberCount: number
  expiresAt: string
}
