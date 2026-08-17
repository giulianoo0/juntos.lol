export async function startScreenShare(
  roomId: string,
  nickname: string,
  onRemoteTrack?: (element: HTMLMediaElement) => void,
) {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/screenshare/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname }),
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
