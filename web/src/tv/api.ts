/**
 * The TV's side of the server: linking by code, the account it was linked
 * to, and the token that stands for it. See /api/tv in the server.
 */
export interface TvAccount {
  id: number
  nickname: string
  avatar?: string
}

export interface TvDevice {
  id: string
  name: string
}

export interface Pairing {
  pairId: string
  /** Eight letters of the room-code alphabet, shown `ABCD-EFGH`. */
  code: string
  expiresAt: string
}

export type PairStatus =
  | { status: 'pending' }
  | { status: 'linked'; token: string; device: TvDevice; account: TvAccount }
  /** The code ran out, or its token was already handed over. */
  | { status: 'expired' }

export const TOKEN_KEY = 'juntos.tv.token'

export function loadToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}

export function saveToken(token: string): void {
  try { localStorage.setItem(TOKEN_KEY, token) } catch { /* private mode: linked for this visit only */ }
}

export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* nothing kept */ }
}

export function formatCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}

/** What the QR opens on the phone: the page that links this code to its account. */
export function linkUrl(code: string, origin = window.location.origin): string {
  return `${origin}/tv/vincular?c=${encodeURIComponent(code)}`
}

export async function startPairing(): Promise<Pairing> {
  const response = await fetch('/api/tv/pair', { method: 'POST' })
  if (!response.ok) throw new Error(`pair failed: ${response.status}`)
  return await response.json() as Pairing
}

export async function pairStatus(pairId: string): Promise<PairStatus> {
  const response = await fetch(`/api/tv/pair/${encodeURIComponent(pairId)}`, { cache: 'no-store' })
  if (response.status === 404) return { status: 'expired' }
  if (!response.ok) throw new Error(`pair status failed: ${response.status}`)
  return await response.json() as PairStatus
}

/** The device and its account, or 'revoked' when the token no longer opens anything. */
export async function fetchTvMe(token: string): Promise<{ device: TvDevice; account: TvAccount } | 'revoked'> {
  const response = await fetch('/api/tv/me', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
  if (response.status === 401) return 'revoked'
  if (!response.ok) throw new Error(`tv me failed: ${response.status}`)
  return await response.json() as { device: TvDevice; account: TvAccount }
}
