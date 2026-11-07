import { publishImportedSubtitle } from '../player/subtitleImport'
import { convertSubtitleFile } from '../subtitleFormats'
import type { ExtSubtitle } from './protocol'

const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024

/** The format of a subtitle whose url says nothing, read from its first lines. */
function formatOf(url: string, text: string): string {
  const named = /\.(srt|vtt|ass|ssa)(?:$|[?#])/i.exec(url)
  if (named) return named[1].toLowerCase()
  if (/^﻿?WEBVTT/.test(text)) return 'vtt'
  if (/^﻿?\s*\[Script Info\]/i.test(text)) return 'ass'
  return 'srt'
}

/**
 * The subtitles an extension sent with `play`, read here and imported for
 * the whole room, in order. One that cannot be read or converted is skipped:
 * the video plays all the same.
 */
export async function importExtensionSubtitles(
  roomId: string,
  memberId: string,
  capability: string,
  mediaGeneration: number,
  subtitles: readonly ExtSubtitle[],
  get: typeof fetch = fetch,
): Promise<number> {
  let imported = 0
  for (const subtitle of subtitles) {
    try {
      const response = await get(subtitle.url, { redirect: 'follow', credentials: 'omit' })
      if (!response.ok) continue
      const data = await response.arrayBuffer()
      if (data.byteLength === 0 || data.byteLength > MAX_SUBTITLE_BYTES) continue
      const head = new TextDecoder().decode(data.slice(0, 64))
      const track = convertSubtitleFile(`legenda.${formatOf(subtitle.url, head)}`, data)
      if (!track) continue
      await publishImportedSubtitle(roomId, memberId, capability, mediaGeneration, {
        ...track,
        language: subtitle.lang,
        title: subtitle.label ?? subtitle.lang,
      })
      imported++
    } catch (error) {
      console.warn('extension subtitle skipped', subtitle.url, error)
    }
  }
  return imported
}
