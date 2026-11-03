import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { MediaSnapshot, RoomInfo } from '../types'

/** A room behind a door answers its members only; they name themselves. */
export function fetchRoomInfo(roomId: string, memberId: string, capability: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
    signal,
    headers: memberId ? { 'X-Member-Id': memberId, 'X-Capability': capability } : undefined,
  })
}

export function emptyRoom(id: string): RoomInfo {
  return {
    id, fileName: '', status: 'empty', mediaGeneration: 0, controllerId: '', audioTracks: null,
    subtitleTracks: null, bitmapSubsSkipped: 0, memberCount: 0, expiresAt: '',
  }
}

/** What of the room's socket keeps the room's info current. */
export interface LiveRoomSync {
  roomVersion: number
  mediaPatch: MediaSnapshot | null
  refreshRoom: () => void
  memberId: string
  capability: string
}

/**
 * The room's info as it moves: fetched again for every version the socket
 * announces (one fetch at a time, the last version always caught), and
 * patched in place by a publish that says what it moved.
 */
export function useLiveRoom(room: RoomInfo, sync: LiveRoomSync): [RoomInfo, Dispatch<SetStateAction<RoomInfo>>] {
  const [liveRoom, setLiveRoom] = useState(room)

  const { mediaPatch, refreshRoom } = sync
  useEffect(() => {
    if (!mediaPatch) return
    setLiveRoom((current) => {
      if (mediaPatch.mediaGeneration !== current.mediaGeneration || mediaPatch.mediaVersion < (current.mediaVersion ?? 0)) {
        refreshRoom()
        return current
      }
      return {
        ...current,
        mediaVersion: mediaPatch.mediaVersion,
        mediaOffsetMs: mediaPatch.mediaOffsetMs,
        mediaRegions: mediaPatch.mediaRegions ?? undefined,
      }
    })
  }, [mediaPatch, refreshRoom])

  const refetch = useRef({ running: false, latest: 0, controller: null as AbortController | null })
  useEffect(() => {
    const state = refetch.current
    state.latest = sync.roomVersion
    if (sync.roomVersion === 0 || state.running) return
    state.running = true
    const controller = new AbortController()
    state.controller = controller
    void (async () => {
      try {
        let fetched = -1
        while (fetched !== state.latest) {
          fetched = state.latest
          const response = await fetchRoomInfo(room.id, sync.memberId, sync.capability, controller.signal)
          if (response.ok) setLiveRoom(await response.json() as RoomInfo)
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.error('room refetch failed', error)
        }
      } finally {
        state.running = false
        state.controller = null
      }
    })()
  }, [sync.roomVersion, room.id, sync.memberId, sync.capability])
  useEffect(() => {
    const state = refetch.current
    return () => {
      state.controller?.abort()
      state.running = false
      state.latest = 0
    }
  }, [room.id])

  return [liveRoom, setLiveRoom]
}
