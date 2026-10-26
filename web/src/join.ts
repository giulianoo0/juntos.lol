/**
 * The door of a room, from the browser's side: what the entry screen shows
 * before joining, trading a password for the ticket the socket's hello
 * carries, the host's switch for who gets in, and the host link the Discord
 * app hands out (the owner token rides in the fragment, which never reaches
 * a server log).
 */

export type JoinMode = 'open' | 'password' | 'approval'

export interface RoomPreview {
  name?: string
  joinMode: JoinMode
  memberCount: number
  /** Up to five, oldest first. */
  nicknames: string[]
}

/** Why a password did not get a ticket. */
export type JoinError = 'bad_password' | 'too_many_attempts' | 'room_not_found' | 'failed'

/** What the socket says to someone at the door, and to the host about them. */
export type DoorEvent =
  | { type: 'lobby' }
  | { type: 'knock'; requestId: string; nickname: string }
  | { type: 'admitted' }
  | { type: 'denied' }

/** The host's answer to a knock, for the room socket's send. */
export type DoorAnswer = { type: 'admit' | 'deny'; targetId: string }

const ticketKey = (roomId: string) => `ss.join-ticket.${roomId}`
// The same key upload.ts keeps the creator's token under.
const ownerKey = (roomId: string) => `ss.owner.${roomId}`

const room = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`

export async function fetchRoomPreview(roomId: string): Promise<RoomPreview | null> {
  const response = await fetch(`${room(roomId)}/preview`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error('preview unavailable')
  return await response.json() as RoomPreview
}

/**
 * Trades the password for a ticket and keeps it for this tab, where the
 * hello picks it up with `joinTicketFor`. Throws a {@link JoinError}.
 */
export async function requestJoinTicket(roomId: string, password: string): Promise<string> {
  const response = await fetch(`${room(roomId)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    const known: JoinError[] = ['bad_password', 'too_many_attempts', 'room_not_found']
    throw new Error(known.find((code) => code === body?.error) ?? 'failed')
  }
  const { ticket } = await response.json() as { ticket: string }
  try { sessionStorage.setItem(ticketKey(roomId), ticket) } catch { /* the hello just goes without it */ }
  return ticket
}

/** The ticket this tab got for the room, or '' — the hello's `ticket` field. */
export function joinTicketFor(roomId: string): string {
  try { return sessionStorage.getItem(ticketKey(roomId)) ?? '' } catch { return '' }
}

/** The host's switch for who gets in. A password room needs a password the first time. */
export async function setRoomAccess(roomId: string, memberId: string, capability: string, joinMode: JoinMode, password?: string): Promise<void> {
  const response = await fetch(`${room(roomId)}/access`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, capability, joinMode, ...(password ? { password } : {}) }),
  })
  if (!response.ok) throw new Error('access change rejected')
}

/**
 * A host link (`/room/ID#owner=TOKEN`) makes this browser the room's owner:
 * the token is kept where the creator's own is, and taken out of the address
 * bar so it is not shared by accident. Returns whether there was one.
 */
export function claimOwnerFromHash(roomId: string, hash = typeof location === 'undefined' ? '' : location.hash): boolean {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('owner')
  if (!token) return false
  try { localStorage.setItem(ownerKey(roomId), token) } catch { /* the link still works this once */ }
  if (typeof history !== 'undefined' && typeof location !== 'undefined') {
    history.replaceState(history.state, '', location.pathname + location.search)
  }
  return true
}
