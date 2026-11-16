import { useCallback, useEffect, useState } from 'react'
import { fetchFriends, type Friend } from '../account'
import { useInbox } from './inbox'

const REFRESH_MS = 60_000

const names = new Map<number, string>()

/** A friend's nickname as the last list said it. */
export function nameOf(id: number): string {
  return names.get(id) ?? `#${id}`
}

/** Where a friend is, from most to least reachable. */
export type Whereabouts = 'room' | 'juntos' | 'discord' | 'away'

export function whereabouts(friend: Friend): Whereabouts {
  const { presence } = friend
  if (presence.inRoom) return 'room'
  if (presence.online) return 'juntos'
  if (presence.discord && presence.discord !== 'offline') return 'discord'
  return 'away'
}

const rank: Record<Whereabouts, number> = { room: 0, juntos: 1, discord: 2, away: 3 }

export function byWhereabouts(a: Friend, b: Friend): number {
  return rank[whereabouts(a)] - rank[whereabouts(b)] || a.nickname.localeCompare(b.nickname)
}

/** The friends, sorted by who is around, read again whenever the inbox says something moved. */
export function useFriends(signedIn: boolean): { friends: Friend[] | null; failed: boolean; reload: () => void } {
  const { friendsVersion } = useInbox()
  const [friends, setFriends] = useState<Friend[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    if (!signedIn) {
      setFriends(null)
      return
    }
    let live = true
    fetchFriends()
      .then((next) => {
        for (const friend of next) names.set(friend.id, friend.nickname)
        if (live) { setFriends([...next].sort(byWhereabouts)); setFailed(false) }
      })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [signedIn, friendsVersion, tick])

  useEffect(() => {
    if (!signedIn) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') reload() }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [signedIn, reload])

  return { friends, failed, reload }
}
