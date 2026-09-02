/**
 * One room's whole preparo, described as plain data: rebuild the input,
 * remux it, publish the subtitles riding along. The description is
 * structured-cloneable on purpose — the job crosses into a Web Worker so the
 * demux, the mux and every upload stop sharing a thread with the page that
 * is drawing the player.
 */
import { fileInput, rangeInput, type MediaInput } from './mediaInput'
export * from './remuxTypes'
import type { RemuxJob, RemuxSource } from './remuxTypes'
import type { SeekTrace } from './seekTrace'
import { publishSubtitles } from './subtitlePublish'
import { lastPlanRefusal, planClientRemux, runClientRemux, type ClientRemuxHandle } from './clientMedia'

export interface RemuxJobCallbacks {
  onProgress?: (pct: number) => void
  onHandle?: (handle: ClientRemuxHandle) => void
  onTrace?: (trace: SeekTrace) => void
}

export class UnsupportedMediaError extends Error {
  readonly reason: string | null
  constructor(reason: string | null = null) {
    super(reason ? `unsupported media: ${reason}` : 'unsupported media')
    this.name = 'UnsupportedMediaError'
    this.reason = reason
  }
}

export class PlanFailedError extends Error {
  failure: unknown
  constructor(failure: unknown) {
    super('plan failed')
    this.name = 'PlanFailedError'
    this.failure = failure
  }
}

function buildInput(source: RemuxSource): MediaInput {
  switch (source.kind) {
    case 'file': return fileInput(source.file)
    case 'stream': return rangeInput(source.url, source.name, source.size)
    case 'url': return rangeInput(source.url, source.name, source.size)
    case 'input': return source.input
  }
}

/** Runs the whole preparo and resolves when the remux completes. Errors are
 * thrown raw — the caller classifies them. */
export async function runRemuxJob(job: RemuxJob, { onProgress, onHandle, onTrace }: RemuxJobCallbacks): Promise<void> {
  const input = coldAware(buildInput(job.source))
  let plan: Awaited<ReturnType<typeof planClientRemux>>
  try {
    plan = await planClientRemux(input)
  } catch (error) {
    throw new PlanFailedError(error)
  }
  if (!plan) throw new UnsupportedMediaError(lastPlanRefusal())

  const subtitles = publishSubtitles(input, job.sideFiles, job.roomID, job.mediaGeneration)
  try {
    await runClientRemux({
      roomID: job.roomID,
      mediaGeneration: job.mediaGeneration,
      file: input,
      plan,
      onProgress,
      onHandle,
      onTrace,
      onRegionWarm: input.warm,
    })
  } catch (error) {
    input.dispose()
    throw error
  }
  void subtitles.finally(() => input.dispose())
}

/** An input that knows whether the origin is busy with a fresh region. */
interface ColdAwareInput extends MediaInput {
  /** Whether the region being produced has nothing in the bucket yet, and for
   * how long that has been so. */
  cold(): { cold: boolean; forMs: number }
  warm(): void
}

function coldAware(input: MediaInput): ColdAwareInput {
  let coldSince: number | null = Date.now()
  const abortReads = input.abortReads.bind(input)
  return Object.assign(input, {
    abortReads: () => { coldSince = Date.now(); abortReads() },
    cold: () => ({ cold: coldSince !== null, forMs: coldSince === null ? 0 : Date.now() - coldSince }),
    warm: () => { coldSince = null },
  })
}
