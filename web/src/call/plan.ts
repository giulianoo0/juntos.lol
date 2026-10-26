/** What the room says about one member's microphone and camera. */
export interface CallMember {
  id: string
  mic?: boolean
  cam?: boolean
  hostMuted?: boolean
  hostCamOff?: boolean
}

/** Everyone but me whose voice is going out: their microphone on, and the host has not muted them. */
export function hearable(members: CallMember[], selfId: string): string[] {
  return members.filter((member) => member.id !== selfId && member.mic && !member.hostMuted).map((member) => member.id)
}

/** Whether a member's camera is worth subscribing to at all. */
export function viewable(members: CallMember[], memberId: string): boolean {
  const member = members.find((candidate) => candidate.id === memberId)
  return Boolean(member?.cam && !member.hostCamOff)
}
