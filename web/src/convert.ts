// In-memory conversion is only acceptable below this size; larger files need
// OPFS or are uploaded unconverted.
export const BLOB_FALLBACK_MAX_BYTES = 1.5 * 1024 ** 3

// Thrown when the source has no video track; the caller rejects the flow.
export class NoVideoTrackError extends Error {
  constructor() {
    super('no video track')
    this.name = 'NoVideoTrackError'
  }
}

export function isMp4(file: File): boolean {
  return file.type === 'video/mp4' || /\.(mp4|m4v)$/i.test(file.name)
}

function mkvName(name: string): string {
  return `${name.replace(/\.[^.]+$/, '')}.mkv`
}

interface OpfsTarget {
  target: InstanceType<typeof import('mediabunny').StreamTarget>
  getFile: () => Promise<File>
  cleanup: () => Promise<void>
}

// Streams the converted bytes into an OPFS file so multi-GB conversions never
// touch main memory. Returns null when OPFS is unavailable.
async function createOpfsTarget(StreamTarget: typeof import('mediabunny').StreamTarget): Promise<OpfsTarget | null> {
  try {
    const storage = navigator.storage
    if (!storage || typeof storage.getDirectory !== 'function') return null
    const directory = await storage.getDirectory()
    const name = `ss-convert-${crypto.randomUUID()}.mkv`
    const handle = await directory.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    return {
      target: new StreamTarget(writable, { chunked: true }),
      getFile: () => handle.getFile(),
      cleanup: () => directory.removeEntry(name),
    }
  } catch {
    return null
  }
}

// Remuxes an MP4 into a Matroska file (codec copy, no re-encode) so the server
// receives a streamable file even when the moov atom sits at the end. Returns
// the converted File, or null when conversion is impossible/failed — callers
// then upload the original unchanged.
export async function convertMp4ToMkv(file: File, onProgress?: (pct: number) => void): Promise<File | null> {
  const { BlobSource, BufferTarget, Conversion, Input, MP4, MkvOutputFormat, Output, QTFF, StreamTarget } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF] })
  let opfs: OpfsTarget | null = null
  try {
    if (!(await input.getPrimaryVideoTrack())) throw new NoVideoTrackError()
    opfs = await createOpfsTarget(StreamTarget)
    if (!opfs && file.size > BLOB_FALLBACK_MAX_BYTES) return null
    const target = opfs ? opfs.target : new BufferTarget()
    const output = new Output({ format: new MkvOutputFormat(), target })
    const conversion = await Conversion.init({ input, output, showWarnings: false })
    if (!conversion.isValid || conversion.discardedTracks.some(({ track }) => track.type === 'video')) return null
    conversion.onProgress = (progress) => onProgress?.(Math.round(progress * 100))
    await conversion.execute()
    // The conversion finalized the output, which closes the OPFS writable;
    // getFile() then yields a snapshot of the completed file.
    const data = opfs ? await opfs.getFile() : (target as InstanceType<typeof BufferTarget>).buffer
    if (!data) return null
    return new File([data], mkvName(file.name), { type: 'video/x-matroska' })
  } catch (error) {
    if (error instanceof NoVideoTrackError) throw error
    console.error('mp4 to mkv conversion failed', error)
    return null
  } finally {
    input.dispose()
    if (opfs) await opfs.cleanup().catch(() => undefined)
  }
}
