export async function startScreenShare(
  roomId: string,
  memberId: string,
  capability: string,
  onRemoteTrack?: (element: HTMLMediaElement) => void,
) {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/screenshare/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, capability }),
  })
  if (!response.ok) throw new Error('screenshare unavailable')
  const credentials = (await response.json()) as { token: string; url: string }
  const { Room, RoomEvent } = await import('livekit-client')
  const livekitRoom = new Room()
  livekitRoom.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === 'video') onRemoteTrack?.(track.attach())
  })
  await livekitRoom.connect(credentials.url, credentials.token)
  await livekitRoom.localParticipant.setScreenShareEnabled(true)
  return livekitRoom
}
