/**
 * How a local room reads on screen. The desktop host plays the app's cache
 * whatever the server says of the bucket; anyone else sees a room that is
 * still being prepared until the bucket has something to play.
 */
import type { RoomInfo } from '../types'
import type { LocalMedia } from './localRoom'

function mine(local: LocalMedia | null, generation: number): local is LocalMedia {
  return local !== null && local.generation === generation
}

export function localStatus(status: string, local: LocalMedia | null, generation: number): string {
  if (mine(local, generation)) return local.regions.some((r) => r.producedMs > 0) ? 'ready' : 'processing'
  return status === 'local' ? 'uploading' : status
}

/** The room the player is given, and the root it reads the HLS from. */
export function playableRoom(room: RoomInfo, local: LocalMedia | null): { room: RoomInfo; mediaRoot: string | undefined } {
  if (!mine(local, room.mediaGeneration)) return { room, mediaRoot: undefined }
  return {
    room: { ...room, status: localStatus(room.status, local, room.mediaGeneration), mediaRegions: local.regions },
    mediaRoot: local.root,
  }
}
