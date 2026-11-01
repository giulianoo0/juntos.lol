import { isDesktop } from './platform'

const DOWNLOADED_KEY = 'juntos.app-downloaded.v1'
const TRIED_KEY = (roomId: string) => `juntos.open-in-app.${roomId}`
const ROOM_ID = /^[A-Za-z0-9]{4,32}$/

/** This browser fetched an installer: a room opened here next tries the app's own link. */
export function markAppDownloaded(): void {
  try { localStorage.setItem(DOWNLOADED_KEY, '1') } catch {}
}

function downloaded(): boolean {
  try { return localStorage.getItem(DOWNLOADED_KEY) === '1' } catch { return false }
}

/**
 * Where a room link goes to land in the app instead of this tab. Android's Chrome takes an
 * intent that falls back to this page marked `web=1` when the app is missing. On a computer,
 * Chrome and Edge ignore a scheme nobody registered, so they always try `juntos://`; Safari
 * and Firefox show an error for it, so only once they downloaded the app. Web views, iPhones
 * and the apps themselves stay here.
 */
export function appRoomLink(roomId: string, href: string, userAgent: string, appDownloaded: boolean): string | null {
  if (!ROOM_ID.test(roomId)) return null
  const here = new URL(href)
  if (here.searchParams.get('web') === '1') return null
  if (/Android/i.test(userAgent)) {
    if (/; wv\)|JuntosApp\//.test(userAgent) || !/Chrome\//.test(userAgent)) return null
    here.searchParams.set('web', '1')
    return `intent://room/${roomId}#Intent;scheme=juntos;package=lol.juntos.app;S.browser_fallback_url=${encodeURIComponent(here.toString())};end`
  }
  if (/iPhone|iPad|Mobile/i.test(userAgent)) return null
  const chromium = /Chrome\/|Edg\//.test(userAgent) && !/Firefox\//.test(userAgent)
  return chromium || appDownloaded ? `juntos://room/${roomId}` : null
}

/** Once per room and tab, a room opened in a browser hands itself to the app. */
export function openRoomInApp(roomId: string): void {
  if (isDesktop()) return
  try {
    if (sessionStorage.getItem(TRIED_KEY(roomId))) return
    sessionStorage.setItem(TRIED_KEY(roomId), '1')
  } catch {
    return
  }
  const link = appRoomLink(roomId, window.location.href, navigator.userAgent, downloaded())
  if (link) window.location.href = link
}
