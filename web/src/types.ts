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
  /** Microphone and camera as the member set them, and what the host turned off. */
  mic?: boolean
  cam?: boolean
  hostMuted?: boolean
  hostCamOff?: boolean
  /** The account a signed-in member is, by its number, and its avatar. */
  accountId?: number
  avatar?: string
  /** `desktop` for the app; absent for a browser. */
  client?: string
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

/** One member publishing their screen to the room right now. */
export interface ScreenShareInfo {
  memberId: string
  nickname: string
  since: string
}

/** A YouTube live on the relay and who puts it there. */
export interface LiveInfo {
  videoId: string
  title: string
  thumbnail?: string
  producer: 'fleet' | 'jlocal'
  broadcast: string
  /** Who opened it; they run it besides the host. */
  memberId?: string
  /** The live's own progress, apart from the media's: processing, ready or error. */
  status?: string
  error?: string
}

/** What a room shows side by side: one media with a timeline, one live, up to four screens. */
export type StageKind = 'media' | 'live' | 'screen'

/** What the host put in front of everyone; memberId names the screen's owner or the member. */
export interface Spotlight {
  kind: StageKind | 'member'
  memberId?: string
}

export interface RoomInfo {
  id: string
  name?: string
  fileName: string
  /** The media stage's status; 'empty' until someone opens a source. */
  status: string
  spotlight?: Spotlight | null
  joinMode?: 'open' | 'password' | 'approval'
  createdAt?: string
  /** Who opened the media; they drive it besides the host. */
  sourceMemberId?: string
  sourceOrigin?: 'file' | 'torrent' | 'url' | 'youtube'
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
  screens?: ScreenShareInfo[] | null
  live?: LiveInfo | null
  preparation?: RoomPreparation
  memberCount: number
  expiresAt: string
  mediaBaseUrl?: string
  /** A locked room's playlists ask for it. */
  mediaKey?: string
  /** The host's desktop app produces the media; the bucket gets it only for browser guests. */
  localSource?: boolean
  /** Extra variants the server asked of the producer (`480p` for a slow browser guest). */
  renditions?: string[]
}
