/**
 * Reads the chapter atoms out of a Matroska file, because mediabunny does
 * not: without this, a room prepared by the client pipeline would silently
 * lose the timeline chapters the server's ffprobe would have found.
 *
 * It is a deliberately small EBML walk, not a Matroska parser: top-level
 * Segment children are scanned for Chapters, with SeekHead followed when the
 * muxer put Chapters elsewhere. Anything unexpected returns no chapters —
 * they are annotations, and a wrong guess is worse than none.
 */

export interface MkvChapter {
  startMs: number
  endMs: number
  title: string
}

const EBML_ID = 0x1a45dfa3
const SEGMENT_ID = 0x18538067
const SEEK_HEAD_ID = 0x114d9b74
const CLUSTER_ID = 0x1f43b675
const CHAPTERS_ID = 0x1043a770
const SEEK_ID = 0x4dbb
const SEEK_ID_FIELD = 0x53ab
const SEEK_POSITION = 0x53ac
const EDITION_ENTRY = 0x45b9
const CHAPTER_ATOM = 0xb6
const CHAPTER_TIME_START = 0x91
const CHAPTER_TIME_END = 0x92
const CHAPTER_DISPLAY = 0x80
const CHAP_STRING = 0x85

/** How much of the head is scanned before giving up on finding Chapters. */
const HEAD_SCAN_BYTES = 4 << 20
const MAX_CHAPTERS = 512

class Reader {
  readonly bytes: Uint8Array
  pos: number
  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes
    this.pos = pos
  }
  get length() { return this.bytes.byteLength }
  /** EBML ids keep their length-marker bit; sizes clear it. */
  vint(keepMarker: boolean): number | null {
    if (this.pos >= this.length) return null
    const first = this.bytes[this.pos]
    if (first === 0) return null
    let width = 1
    for (let mask = 0x80; (first & mask) === 0; mask >>= 1) width += 1
    if (this.pos + width > this.length) return null
    let value = keepMarker ? first : first & (0xff >> width)
    for (let i = 1; i < width; i += 1) value = value * 256 + this.bytes[this.pos + i]
    this.pos += width
    return value
  }
  uint(size: number): number {
    let value = 0
    for (let i = 0; i < size && this.pos + i < this.length; i += 1) value = value * 256 + this.bytes[this.pos + i]
    this.pos += size
    return value
  }
  utf8(size: number): string {
    const end = Math.min(this.pos + size, this.length)
    const text = new TextDecoder().decode(this.bytes.subarray(this.pos, end))
    this.pos += size
    return text.replace(/\0+$/, '')
  }
}

export async function readMkvChapters(file: File): Promise<MkvChapter[]> {
  try {
    const head = new Uint8Array(await file.slice(0, Math.min(HEAD_SCAN_BYTES, file.size)).arrayBuffer())
    const reader = new Reader(head)
    if (reader.vint(true) !== EBML_ID) return []
    const ebmlSize = reader.vint(false)
    if (ebmlSize === null) return []
    reader.pos += ebmlSize
    if (reader.vint(true) !== SEGMENT_ID) return []
    if (reader.vint(false) === null) return []
    const segmentStart = reader.pos

    // Walk the segment's top level. Chapters either appear here directly or
    // the SeekHead says where they are; a Cluster means the head is over.
    let chaptersAt = -1
    while (reader.pos < reader.length) {
      const id = reader.vint(true)
      const size = reader.vint(false)
      if (id === null || size === null) break
      if (id === CHAPTERS_ID) return parseChapters(new Reader(head.subarray(reader.pos, reader.pos + size)))
      if (id === SEEK_HEAD_ID) {
        const found = findChaptersSeek(new Reader(head.subarray(reader.pos, reader.pos + size)))
        if (found >= 0) chaptersAt = segmentStart + found
      }
      if (id === CLUSTER_ID) break
      reader.pos += size
    }
    if (chaptersAt < 0) return []

    // The SeekHead pointed past what was read; fetch just that element.
    const idProbe = new Reader(new Uint8Array(await file.slice(chaptersAt, Math.min(chaptersAt + 12, file.size)).arrayBuffer()))
    if (idProbe.vint(true) !== CHAPTERS_ID) return []
    const bodySize = idProbe.vint(false)
    if (bodySize === null || bodySize > HEAD_SCAN_BYTES) return []
    const bodyStart = chaptersAt + idProbe.pos
    const body = new Uint8Array(await file.slice(bodyStart, bodyStart + bodySize).arrayBuffer())
    return parseChapters(new Reader(body))
  } catch {
    return []
  }
}

/** Reads Seek entries and answers the Chapters position, or -1. */
function findChaptersSeek(reader: Reader): number {
  while (reader.pos < reader.length) {
    const id = reader.vint(true)
    const size = reader.vint(false)
    if (id === null || size === null) return -1
    if (id !== SEEK_ID) {
      reader.pos += size
      continue
    }
    const entry = new Reader(reader.bytes.subarray(reader.pos, reader.pos + size))
    reader.pos += size
    let target = -1
    let position = -1
    while (entry.pos < entry.length) {
      const fieldID = entry.vint(true)
      const fieldSize = entry.vint(false)
      if (fieldID === null || fieldSize === null) break
      if (fieldID === SEEK_ID_FIELD) target = entry.uint(fieldSize)
      else if (fieldID === SEEK_POSITION) position = entry.uint(fieldSize)
      else entry.pos += fieldSize
    }
    if (target === CHAPTERS_ID && position >= 0) return position
  }
  return -1
}

function parseChapters(reader: Reader): MkvChapter[] {
  const chapters: MkvChapter[] = []
  const walk = (r: Reader) => {
    while (r.pos < r.length && chapters.length < MAX_CHAPTERS) {
      const id = r.vint(true)
      const size = r.vint(false)
      if (id === null || size === null) return
      const body = r.bytes.subarray(r.pos, r.pos + size)
      r.pos += size
      if (id === EDITION_ENTRY) walk(new Reader(body))
      else if (id === CHAPTER_ATOM) {
        const atom = readAtom(new Reader(body))
        if (atom) chapters.push(atom)
      }
    }
  }
  walk(reader)
  chapters.sort((a, b) => a.startMs - b.startMs)
  // End times are optional in the container; a missing one runs to the next
  // chapter's start, matching what ffprobe reports.
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i].endMs <= chapters[i].startMs && i + 1 < chapters.length) {
      chapters[i].endMs = chapters[i + 1].startMs
    }
  }
  return chapters.filter((chapter) => chapter.endMs > chapter.startMs)
}

function readAtom(reader: Reader): MkvChapter | null {
  let startMs = -1
  let endMs = 0
  let title = ''
  while (reader.pos < reader.length) {
    const id = reader.vint(true)
    const size = reader.vint(false)
    if (id === null || size === null) break
    if (id === CHAPTER_TIME_START) startMs = reader.uint(size) / 1e6
    else if (id === CHAPTER_TIME_END) endMs = reader.uint(size) / 1e6
    else if (id === CHAPTER_DISPLAY) {
      const display = new Reader(reader.bytes.subarray(reader.pos, reader.pos + size))
      reader.pos += size
      while (display.pos < display.length) {
        const fieldID = display.vint(true)
        const fieldSize = display.vint(false)
        if (fieldID === null || fieldSize === null) break
        if (fieldID === CHAP_STRING && !title) title = display.utf8(fieldSize)
        else display.pos += fieldSize
      }
    } else reader.pos += size
  }
  if (startMs < 0) return null
  return { startMs: Math.round(startMs), endMs: Math.round(endMs), title }
}
