/**
 * How big a remote file is, before reading it. HEAD first; an origin that
 * refuses HEAD (a media proxy answers only GET) is asked for its first byte
 * and the total comes from Content-Range.
 */

export interface ProbedSize {
  size: number
  type: string | null
}

function length(response: Response): number | null {
  const raw = response.headers.get('Content-Length')
  const size = raw === null ? NaN : Number(raw)
  return Number.isSafeInteger(size) && size > 0 ? size : null
}

function rangeTotal(response: Response): number | null {
  const match = /^bytes \d+-\d+\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')
  return match ? Number(match[1]) : null
}

export async function probeSize(url: string, { fetch: get = fetch, signal }: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<ProbedSize> {
  try {
    const head = await get(url, { method: 'HEAD', signal })
    const size = head.ok ? length(head) : null
    if (size !== null) return { size, type: head.headers.get('Content-Type') }
  } catch (error) {
    if (signal?.aborted) throw error
  }
  const first = await get(url, { headers: { Range: 'bytes=0-0' }, signal })
  // A 200 here is the whole file coming down: its length is all that is wanted.
  first.body?.cancel().catch(() => {})
  const size = first.status === 206 ? rangeTotal(first) : first.ok ? length(first) : null
  if (size === null) throw new Error(`no size for ${new URL(url).host} (${first.status})`)
  return { size, type: first.headers.get('Content-Type') }
}
