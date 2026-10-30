import type { ReactNode } from 'react'

/**
 * What the room's screens (`room/ui`) draw and what they can ask for. The
 * integration builds one from `useSync` + `useCall` + `stages` + `join`;
 * `/dev/sala` builds a fake one. The screens hold only what is theirs to
 * hold: which tab of the side panel is open, what this viewer pinned,
 * whether they left the host's spotlight.
 */

export type JoinMode = 'open' | 'password' | 'approval'

export interface Person {
  id: string
  name: string
  host: boolean
  /** Declared by the person. */
  mic: boolean
  cam: boolean
  /** Whether their voice is above the speaking threshold now. */
  speaking: boolean
  /** The host silenced them or turned their camera off. */
  hostMuted: boolean
  hostCamOff: boolean
  /** The account's public number, for who signed in. */
  accountId?: number
  /** Their mascot (`fox.bowtie`); absent draws a default one from the id. */
  avatar?: string
  /** In the desktop app rather than a browser. */
  app?: boolean
}

export type StageKind = 'media' | 'live' | 'screen'

export interface Stage {
  /** `media`, `live` or `screen:<ownerId>`. */
  id: string
  kind: StageKind
  /** What it shows: the film's name, "Tela de Bruno". */
  title: string
  ownerId: string
}

export type Spotlight =
  | { kind: 'media' | 'live' }
  | { kind: 'screen' | 'member'; memberId: string }

export type RequestKind = 'media' | 'screen' | 'live'

/** A guest asking the host for a stage (host only). */
export interface StageRequest {
  id: string
  memberId: string
  name: string
  kind: RequestKind
}

/** Someone at the door of an approval room (host only). */
export interface Knock {
  id: string
  name: string
}

export interface ChatMessage {
  id: string
  /** Empty for a line of the room ("Ana entrou"). */
  authorId: string
  author: string
  text: string
  /** Epoch ms. */
  at: number
  system?: boolean
}

/** Someone's reaction: it floats over their tile, never in the chat. */
export interface Reaction {
  id: string
  memberId: string
  emoji: string
  /** Epoch ms, on this browser's clock. */
  at: number
}

/** What the "Compartilhar" menu opens. */
export type ShareSource = 'screen' | 'file' | 'torrent' | 'youtube' | 'drive' | 'catalog'

export interface RoomActions {
  setMic: (on: boolean) => void
  setCam: (on: boolean) => void
  /** A guest's pick becomes a request to the host; the host's opens it. */
  share: (source: ShareSource) => void
  react: (emoji: string) => void
  sendChat: (text: string) => void
  leave: () => void
  copyLink: () => void
  /** Host: `null` takes the spotlight off. */
  spotlight: (spotlight: Spotlight | null) => void
  answerRequest: (requestId: string, allow: boolean) => void
  admit: (knockId: string) => void
  deny: (knockId: string) => void
  hostMute: (memberId: string) => void
  hostCamOff: (memberId: string) => void
  kick: (memberId: string) => void
  makeHost: (memberId: string) => void
  setAccess: (mode: JoinMode, password?: string) => void
  /** Host, or the stage's owner. */
  closeStage: (stage: Stage) => void
  /** Someone's account page; the call waits in the corner meanwhile. */
  openProfile: (accountId: number) => void
  /** The desktop app's download, for a source only the app opens. */
  getApp?: () => void
}

export interface RoomSlots {
  /** Someone's camera, or yours; called only for tiles on screen with the
      camera on. */
  renderVideo: (memberId: string) => ReactNode
  /** The player, the live or the screen, filling its box. */
  renderStage: (stage: Stage, size: 'focus' | 'thumb') => ReactNode
  /** A small reading beside the stage's tags, shown on hover (the buffer). */
  renderStageTag?: (stage: Stage) => ReactNode
  /** The picker a "Compartilhar" pick opens (torrent, YouTube, catálogo),
      in a dialog; `null` when the pick needs no picker (tela, arquivo). */
  renderShare?: (source: ShareSource, close: () => void) => ReactNode
}

export interface RoomViewModel {
  name: string
  /** What the link pill shows and copies: `juntos.lol/K7Q2M9XA`. */
  link: string
  /** When the room opened, epoch ms: the header's clock. */
  startedAt: number
  joinMode: JoinMode
  selfId: string
  isHost: boolean
  people: Person[]
  stages: Stage[]
  spotlight: Spotlight | null
  requests: StageRequest[]
  knocks: Knock[]
  chat: ChatMessage[]
  /** Reactions, newest last; only the fresh ones float. */
  reactions: Reaction[]
  /** Sources the share menu offers here (the screen needs a desktop browser). */
  sources: ShareSource[]
  /** Of those, the ones only the desktop app opens: shown locked here. */
  appOnly?: ShareSource[]
  /** 0..1, how loud someone's voice is now; read on the mascot's frame. */
  levelOf?: (memberId: string) => number
  actions: RoomActions
  slots: RoomSlots
}

/** The entrance: before the room, your mascot, your name and, when asked, the password. */
export interface EntryViewModel {
  name: string
  joinMode: JoinMode
  /** Up to five, for the faces and the line under the name. */
  present: string[]
  presentCount: number
  nickname: string
  mic: boolean
  cam: boolean
  /** 0..1, your microphone's level now, while it is on. */
  level?: () => number
  /** Your mascot (`fox.bowtie`); an account's own, or the one this browser picked. */
  avatar: string
  /** Keeps a new pick: in this browser, and on the account when signed in. */
  setAvatar: (avatar: string) => void
  /** Who is signed in; null for a guest. */
  account: { id: number } | null
  /** Where "Entrar com Discord" goes, coming back to this room. */
  loginUrl: string
  busy: boolean
  /** A wrong password, a closed door: said under the field. */
  error?: string
  setMic: (on: boolean) => void
  setCam: (on: boolean) => void
  join: (input: { nickname: string; password: string }) => void
  /** Your camera, mirrored, beside the mascot; called only while it is on. */
  renderPreview: () => ReactNode
}

/** Waiting for the host to let you in (an approval room). */
export interface WaitingViewModel {
  name: string
  nickname: string
  /** Your mascot, knocking. */
  avatar?: string
  cancel: () => void
}
