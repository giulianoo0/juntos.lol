import type { Room as LiveKitRoom } from 'livekit-client'

const pendingStreams = new Map<string, MediaStream>()

/**
 * Must be called from inside the click: browsers require live user activation
 * and Firefox drops it after a single await, so nothing may be awaited first.
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

export function isScreenShareCancelled(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')
}

interface ScreenShareOptions {
  publish?: boolean
  stream?: MediaStream | null
}

// Joins the room's WebRTC session, publishing an already granted stream when
// one is passed so no second picker is needed.
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
