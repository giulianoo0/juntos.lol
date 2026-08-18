import type { Room as LiveKitRoom } from 'livekit-client'

// A screen the user already granted, waiting for the room it belongs to.
// Acquiring the stream is what needs the click, but the room it will be shown
// in may not exist yet, so the grant is parked here across the navigation
// instead of asking for it a second time.
const pendingStreams = new Map<string, MediaStream>()

/**
 * Asks for a screen, from inside the click that requested it.
 *
 * This runs before a room is created or repointed: cancelling the picker then
 * leaves everything untouched instead of stranding a room with nothing to
 * show. Browsers also require live user activation here, and Firefox drops it
 * after a single await, so nothing may be awaited before this call.
 */
export function requestScreenStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
}

export function stashScreenStream(roomID: string, stream: MediaStream): void {
  pendingStreams.get(roomID)?.getTracks().forEach((track) => track.stop())
  pendingStreams.set(roomID, stream)
}

export function takeScreenStream(roomID: string): MediaStream | null {
  const stream = pendingStreams.get(roomID) ?? null
  pendingStreams.delete(roomID)
  return stream
}

export function dropScreenStream(roomID: string): void {
  takeScreenStream(roomID)?.getTracks().forEach((track) => track.stop())
}

// Closing the picker is a normal outcome, not a failure to report.
export function isScreenShareCancelled(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')
}

interface ScreenShareOptions {
  /** Publish this client's own screen. Viewers of a screen room only subscribe. */
  publish?: boolean
  /** A screen already granted by requestScreenStream, published as-is. */
  stream?: MediaStream | null
}

// Joins the room's WebRTC session. Publishing an already granted stream avoids
// a second picker, which after any await some browsers refuse outright.
export async function startScreenShare(
  roomId: string,
  memberId: string,
  capability: string,
  onRemoteTrack?: (element: HTMLMediaElement) => void,
  options: ScreenShareOptions = {},
): Promise<LiveKitRoom> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/screenshare/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, capability }),
  })
  if (!response.ok) throw new Error('screenshare unavailable')
  const credentials = (await response.json()) as { token: string; url: string }
  const { Room, RoomEvent, Track } = await import('livekit-client')
  const livekitRoom = new Room()
  livekitRoom.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === 'video') onRemoteTrack?.(track.attach())
  })
  await livekitRoom.connect(credentials.url, credentials.token)

  if (options.stream) {
    const [track] = options.stream.getVideoTracks()
    if (track) await livekitRoom.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare })
  } else if (options.publish !== false) {
    await livekitRoom.localParticipant.setScreenShareEnabled(true)
  }
  return livekitRoom
}
