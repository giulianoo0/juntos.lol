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

// A catalog title a viewer asked the controller to switch the room to. The
// server relays it with `from` filled in; `id` is client-side, for React keys
// and dismissal.
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

// One member's buffering picture while the room waits for a gated start.
export interface MemberReadiness {
  memberId: string
  bufferAheadMs: number
  stalled?: boolean
  ready: boolean
  // Whether the controller excused this member: the room stopped waiting for
  // them and they watch at their own pace.
  ignored?: boolean
}

// The pending gated start the server is holding: where playback will begin
// and how far along each member's buffer is.
export interface RoomWaiting {
  targetMs: number
  readiness: MemberReadiness[]
}

// One row of the chat timeline: either a message someone sent or a presence
// note the client synthesized.
export interface ChatEntry {
  author: string
  text: string
  at: string
  system?: boolean
}

// How far the room is from being playable, as the server sees it. It replaces
// what used to be a purely local guess in whichever tab did the uploading.
export interface RoomPreparation {
  // Size of the incoming file, and how much of it the server holds.
  sourceBytes?: number
  receivedBytes?: number
  // Which stage the preview is in. 'unavailable' means this source cannot be
  // previewed at all and only plays once the whole file has arrived.
  previewPhase?: 'receiving' | 'probing' | 'segmenting' | 'unavailable'
  // How many bytes the preview is expected to need before the first segment
  // can be published. Absent while the bitrate is still unknown.
  previewTargetBytes?: number
}

// RoomChapter is one authored span of the media, in milliseconds.
export interface RoomChapter {
  startMs: number
  endMs: number
  title?: string
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
  // Increments when the media behind the current generation is republished in
  // place (the final remux replacing the progressive preview), telling the
  // player to reload the same source URL. Optional: older responses omit it.
  mediaVersion?: number
  // Increments when subtitle files are rewritten under their stable names, so
  // <track> elements refetch cues the browser would otherwise cache forever.
  subsVersion?: number
  // Whether play and seek wait for every member to buffer the target.
  // Controller-owned; the live value travels over the sync protocol.
  gatingEnabled?: boolean
  errorMessage?: string
  controllerId: string
  audioTracks: TrackInfo[] | null
  subtitleTracks: TrackInfo[] | null
  // The source's authored spans (openings, recaps), when the container
  // carries any: the player draws them on the timeline.
  chapters?: RoomChapter[] | null
  bitmapSubsSkipped: number
  preparation?: RoomPreparation
  memberCount: number
  expiresAt: string
  // Where this room's media objects are served from. Segments and subtitles
  // come straight from the bucket; only playlists come from the application.
  // Optional: a response from before the move omits it.
  mediaBaseUrl?: string
}
