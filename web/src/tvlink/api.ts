/**
 * The TVs linked to the signed-in account, from the phone's or the
 * desktop's side (/api/tv/*). The session is the account cookie; every
 * call throws the server's error code (`code_not_found`, `tv_offline`,
 * `not_in_room`) or `failed`.
 */

/** What a TV plays out loud: the stage's volume and each person's, 0..1. */
export interface Mix {
  media: number
  /** memberId → level; absent is 1. */
  people: Record<string, number>
}

export interface TvDevice {
  id: string
  name: string
  /** Its /ws/tv is open: it can take a cast. */
  online: boolean
  /** The room it plays now. */
  roomId?: string
  mix: Mix
}

const json = { 'Content-Type': 'application/json' }

async function send(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`/api/tv${path}`, init)
  if (response.ok) return response
  const body = await response.json().catch(() => null) as { error?: string } | null
  throw new Error(body?.error ?? 'failed')
}

const device = (id: string) => `/devices/${encodeURIComponent(id)}`

/** Links the TV showing `code` (with or without the hyphen) to this account. */
export async function linkTv(code: string): Promise<{ id: string; name: string }> {
  const response = await send('/link', { method: 'POST', headers: json, body: JSON.stringify({ code }) })
  return (await response.json() as { device: { id: string; name: string } }).device
}

export async function fetchTvDevices(): Promise<TvDevice[]> {
  const response = await send('/devices')
  const body = await response.json() as { devices?: TvDevice[] } | null
  return Array.isArray(body?.devices) ? body.devices.map((each) => ({ ...each, mix: normalMix(each.mix) })) : []
}

export async function renameTv(id: string, name: string): Promise<void> {
  await send(device(id), { method: 'PATCH', headers: json, body: JSON.stringify({ name }) })
}

export async function unlinkTv(id: string): Promise<void> {
  await send(device(id), { method: 'DELETE' })
}

/** Has the TV play room `roomId`; the account must be in it. */
export async function castTv(id: string, roomId: string): Promise<void> {
  await send(`${device(id)}/cast`, { method: 'POST', headers: json, body: JSON.stringify({ roomId }) })
}

export async function stopTv(id: string): Promise<void> {
  await send(`${device(id)}/stop`, { method: 'POST' })
}

export async function putTvMix(id: string, mix: Mix): Promise<void> {
  await send(`${device(id)}/mix`, { method: 'PUT', headers: json, body: JSON.stringify(mix) })
}

function normalMix(mix: Partial<Mix> | null | undefined): Mix {
  return {
    media: typeof mix?.media === 'number' ? mix.media : 1,
    people: mix?.people && typeof mix.people === 'object' ? mix.people : {},
  }
}
