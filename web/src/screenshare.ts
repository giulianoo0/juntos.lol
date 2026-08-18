// Joins the room's WebRTC session. `publish` decides whether this client also
// offers its own screen: a viewer of a screen-share room only subscribes, and
// the controller publishes from inside its own click so the browser still sees
// a user gesture when the picker opens.
export async function startScreenShare(
  roomId: string,
  memberId: string,
  capability: string,
  onRemoteTrack?: (element: HTMLMediaElement) => void,
  options: { publish?: boolean } = {},
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
  if (options.publish !== false) await livekitRoom.localParticipant.setScreenShareEnabled(true)
  return livekitRoom
}
