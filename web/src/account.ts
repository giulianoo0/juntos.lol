/**
 * Accounts from the browser's side: signing in with Discord, the signed-in
 * account, friends and what people watched. The session is an httpOnly
 * cookie, so nothing here keeps a token; every call just sends the cookie.
 */
import { useEffect, useSyncExternalStore } from 'react'

export type Visibility = 'public' | 'friends' | 'private'

/** How an account shows up anywhere: its number, nickname and avatar. */
export interface AccountCard {
  id: number
  nickname: string
  /** Short spec like `fox.bowtie`; '' is the default avatar. */
  avatar: string
}

export interface AccountStats {
  sessions: number
  hours: number
  friends: number
}

/** The Discord names behind an account, as Discord last said them at sign-in. */
export interface DiscordNames {
  username: string
  globalName?: string
}

export interface Me extends AccountCard {
  visibility: Visibility
  /** Who sees the Discord names on the profile: everyone, or only oneself. */
  discordVisibility: 'public' | 'private'
  discord?: DiscordNames
  createdAt: string
  stats: AccountStats
}

/** A profile; stats are left out when the account does not show them to the viewer. */
export interface Profile extends AccountCard {
  stats?: AccountStats
  /** Only when the account shows it, or it is one's own. */
  discord?: DiscordNames
}

export interface Friend extends AccountCard {
  /** roomId only comes for a room anyone may walk into; withMe when it is the room one is in. */
  presence: { inRoom: boolean; roomId?: string; withMe?: boolean }
}

export interface FriendRequests {
  incoming: AccountCard[]
  outgoing: AccountCard[]
}

export interface HistoryEntry {
  /** Only on one's own history. */
  roomId?: string
  title: string
  kind: string
  startedAt: string
  durationSec: number
  with: AccountCard[]
}

export interface MeChanges {
  nickname?: string
  avatar?: string
  visibility?: Visibility
  discordVisibility?: 'public' | 'private'
}

/** A friend calling one into a room. */
export interface RoomInvite {
  from: AccountCard
  roomId: string
  roomName?: string
  at: string
}

/** What waits on the signed-in account: requests to answer and calls into rooms. */
export interface Notifications {
  friendRequests: AccountCard[]
  invites: RoomInvite[]
}

const json = { 'Content-Type': 'application/json' }

async function errorCode(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: string } | null
  return body?.error ?? 'failed'
}

/** An account's page. */
export function profilePath(id: number): string {
  return `/c/${id}`
}

/** Where to send the browser to sign in; it comes back to `next`, a path on this site. */
export function discordLoginUrl(next?: string): string {
  return next ? `/api/auth/discord?next=${encodeURIComponent(next)}` : '/api/auth/discord'
}

/** The signed-in account, or null for nobody. */
export async function fetchMe(): Promise<Me | null> {
  const response = await fetch('/api/me')
  if (response.status === 401) return null
  if (!response.ok) throw new Error(await errorCode(response))
  return await response.json() as Me
}

/** Changes nickname, avatar or visibility. Throws `invalid_account` for a value the server refuses. */
export async function updateMe(changes: MeChanges): Promise<Me> {
  const response = await fetch('/api/me', { method: 'PATCH', headers: json, body: JSON.stringify(changes) })
  if (!response.ok) throw new Error(await errorCode(response))
  const me = await response.json() as Me
  setMe(me)
  return me
}

export async function logout(): Promise<void> {
  const response = await fetch('/api/auth/logout', { method: 'POST' })
  if (!response.ok) throw new Error(await errorCode(response))
  setMe(null)
}

export async function fetchFriends(): Promise<Friend[]> {
  const response = await fetch('/api/friends')
  if (!response.ok) throw new Error(await errorCode(response))
  return (await response.json() as { friends: Friend[] }).friends
}

export async function fetchFriendRequests(): Promise<FriendRequests> {
  const response = await fetch('/api/friends/requests')
  if (!response.ok) throw new Error(await errorCode(response))
  return await response.json() as FriendRequests
}

/**
 * Asks account `id` to be friends. 'friends' when they had already asked
 * back. Throws `user_not_found`, `invalid_friend` or `too_many_requests`.
 */
export async function requestFriend(id: number): Promise<'requested' | 'friends'> {
  const response = await fetch('/api/friends/requests', { method: 'POST', headers: json, body: JSON.stringify({ id }) })
  if (!response.ok) throw new Error(await errorCode(response))
  return (await response.json() as { state: 'requested' | 'friends' }).state
}

export async function acceptFriend(id: number): Promise<void> {
  const response = await fetch(`/api/friends/requests/${id}/accept`, { method: 'POST' })
  if (!response.ok) throw new Error(await errorCode(response))
}

/** Declines a request from `id`, or withdraws one sent to them. */
export async function dropFriendRequest(id: number): Promise<void> {
  const response = await fetch(`/api/friends/requests/${id}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await errorCode(response))
}

export async function removeFriend(id: number): Promise<void> {
  const response = await fetch(`/api/friends/${id}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await errorCode(response))
}

export async function fetchNotifications(): Promise<Notifications> {
  const response = await fetch('/api/notifications')
  if (!response.ok) throw new Error(await errorCode(response))
  const body = await response.json() as Partial<Notifications> | null
  return {
    friendRequests: Array.isArray(body?.friendRequests) ? body.friendRequests : [],
    invites: Array.isArray(body?.invites) ? body.invites : [],
  }
}

/** Clears the call from friend `from`, joined or not. */
export async function dismissInvite(from: number): Promise<void> {
  const response = await fetch(`/api/invites/${from}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await errorCode(response))
}

/** A refused invite: `message` is the server's code; `roomId` comes with `dm_closed`, to copy as a link instead. */
export class InviteError extends Error {
  readonly roomId?: string

  constructor(code: string, roomId?: string) {
    super(code)
    this.roomId = roomId
  }
}

/**
 * Has the bot DM friend `id` a link to the room one is in. Throws an
 * InviteError: `not_in_room`, `dm_closed`, `invites_disabled`,
 * `too_many_invites`, `not_friends` or another failure.
 */
export async function inviteFriend(id: number): Promise<void> {
  const response = await fetch(`/api/friends/${id}/invite`, { method: 'POST' })
  if (response.ok) return
  const body = await response.json().catch(() => null) as { error?: string; roomId?: string } | null
  throw new InviteError(body?.error ?? 'failed', body?.roomId)
}

/** A profile; null when no one has the number, 'private' when its owner shows it to no one. */
export async function fetchProfile(id: number): Promise<Profile | null | 'private'> {
  const response = await fetch(`/api/users/${id}`)
  if (response.status === 404) return null
  if (response.status === 403) return 'private'
  if (!response.ok) throw new Error(await errorCode(response))
  return await response.json() as Profile
}

/** What an account watched, newest first; null when it does not show it to the viewer. */
export async function fetchHistory(id: number): Promise<HistoryEntry[] | null> {
  const response = await fetch(`/api/users/${id}/history`)
  if (response.status === 403 || response.status === 404) return null
  if (!response.ok) throw new Error(await errorCode(response))
  return (await response.json() as { history: HistoryEntry[] }).history
}

// One copy of the signed-in account for every useMe, so a logout or a
// change made anywhere shows everywhere.
type MeState = { me: Me | null; loading: boolean }
let current: MeState = { me: null, loading: true }
let requested = false
const listeners = new Set<() => void>()

function publish(next: MeState) {
  current = next
  for (const listener of listeners) listener()
}

function setMe(me: Me | null) {
  publish({ me, loading: false })
}

/** Asks the server again who is signed in. */
export async function refreshMe(): Promise<void> {
  try {
    setMe(await fetchMe())
  } catch {
    publish({ me: current.me, loading: false })
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The signed-in account, null for nobody; `loading` until the first answer. */
export function useMe(): MeState {
  const state = useSyncExternalStore(subscribe, () => current)
  useEffect(() => {
    if (requested) return
    requested = true
    void refreshMe()
  }, [])
  return state
}
