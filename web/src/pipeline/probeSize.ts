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

/** Kept across the probes of one origin: a HEAD it refused once is not asked again. */
export interface ProbeMemo {
  headRefused: boolean
}

export async function probeSize(url: string, { fetch: get = fetch, signal, memo }: { fetch?: typeof fetch; signal?: AbortSignal; memo?: ProbeMemo } = {}): Promise<ProbedSize> {
  if (!memo?.headRefused) {
    try {
      const head = await get(url, { method: 'HEAD', signal })
      const size = head.ok ? length(head) : null
      if (size !== null) return { size, type: head.headers.get('Content-Type') }
    } catch (error) {
      if (signal?.aborted) throw error
    }
  }
  const first = await get(url, { headers: { Range: 'bytes=0-0' }, signal })
  // A 200 here is the whole file coming down: its length is all that is wanted.
  first.body?.cancel().catch(() => {})
  const size = first.status === 206 ? rangeTotal(first) : first.ok ? length(first) : null
  if (size === null) throw new Error(`no size for ${new URL(url).host} (${first.status})`)
  if (memo) memo.headRefused = true
  return { size, type: first.headers.get('Content-Type') }
}
