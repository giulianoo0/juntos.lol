import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RoomTv } from '../room/model'
import { castTv, fetchTvDevices, linkTv, putTvMix, stopTv, type Mix, type TvDevice } from './api'

export const POLL_MS = 2_000
// A slider sends while it moves; the TV gets where it stopped.
const WRITE_MS = 250

type Pending = { mix: Mix; timer: number }

/**
 * The room's "Espelhar na TV" on the real API: the account's TVs, asked
 * once on the way in and every 2 s while the menu is open or one of them
 * plays this room. A mix shows at once and is written when the hand
 * stops; until then a poll does not take it back.
 */
export function useRoomTv({ roomId, signedIn, loginUrl }: { roomId: string; signedIn: boolean; loginUrl: string }): RoomTv {
  const [devices, setDevices] = useState<TvDevice[] | null>(null)
  const [watching, setWatching] = useState(false)
  const pending = useRef(new Map<string, Pending>())

  const refresh = useCallback(async () => {
    try {
      const next = await fetchTvDevices()
      setDevices(next.map((device) => {
        const mine = pending.current.get(device.id)
        return mine ? { ...device, mix: mine.mix } : device
      }))
    } catch {
      setDevices((current) => current ?? [])
    }
  }, [])

  useEffect(() => {
    if (signedIn) void refresh()
  }, [signedIn, refresh])

  const playingHere = devices?.some((device) => device.roomId === roomId) ?? false
  useEffect(() => {
    if (!signedIn || !(watching || playingHere)) return undefined
    const timer = window.setInterval(() => { void refresh() }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [signedIn, watching, playingHere, refresh])

  const write = useCallback((id: string) => {
    const mine = pending.current.get(id)
    if (!mine) return
    window.clearTimeout(mine.timer)
    void putTvMix(id, mine.mix).catch(() => undefined).finally(() => {
      if (pending.current.get(id) === mine) pending.current.delete(id)
    })
  }, [])

  // Leaving the room mid-drag still lands the last level.
  useEffect(() => () => { for (const id of [...pending.current.keys()]) write(id) }, [write])

  const watch = useCallback((open: boolean) => {
    setWatching(open)
    if (open) void refresh()
  }, [refresh])

  const setMix = useCallback((id: string, mix: Mix) => {
    setDevices((current) => current?.map((device) => (device.id === id ? { ...device, mix } : device)) ?? current)
    const before = pending.current.get(id)
    if (before) window.clearTimeout(before.timer)
    pending.current.set(id, { mix, timer: window.setTimeout(() => write(id), WRITE_MS) })
  }, [write])

  const cast = useCallback(async (id: string) => {
    await castTv(id, roomId)
    await refresh()
  }, [roomId, refresh])

  const stop = useCallback((id: string) => {
    setDevices((current) => current?.map((device) => (device.id === id ? { ...device, roomId: undefined } : device)) ?? current)
    void stopTv(id).catch(() => undefined).then(refresh)
  }, [refresh])

  const link = useCallback(async (code: string) => {
    await linkTv(code)
    await refresh()
  }, [refresh])

  return useMemo(() => ({
    signedIn,
    loginUrl,
    devices: devices?.map(({ roomId: playing, ...device }) => ({ ...device, here: playing === roomId })) ?? null,
    watch,
    cast,
    stop,
    setMix,
    link,
  }), [signedIn, loginUrl, devices, roomId, watch, cast, stop, setMix, link])
}
