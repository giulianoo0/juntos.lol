/**
 * ISO 639-2 gives some languages two codes — a bibliographic one and a
 * terminological one — and ffmpeg passes through whichever the container
 * happened to use, so the same dub arrives as "ger" from one release and "deu"
 * from the next. Intl.DisplayNames knows the terminological half at best, so
 * both collapse to 639-1 before it is asked.
 */
const THREE_TO_TWO: Record<string, string> = {
  alb: 'sq', sqi: 'sq', arm: 'hy', hye: 'hy', baq: 'eu', eus: 'eu',
  bur: 'my', mya: 'my', chi: 'zh', zho: 'zh', cze: 'cs', ces: 'cs',
  dut: 'nl', nld: 'nl', fre: 'fr', fra: 'fr', geo: 'ka', kat: 'ka',
  ger: 'de', deu: 'de', gre: 'el', ell: 'el', ice: 'is', isl: 'is',
  mac: 'mk', mkd: 'mk', mao: 'mi', mri: 'mi', may: 'ms', msa: 'ms',
  per: 'fa', fas: 'fa', rum: 'ro', ron: 'ro', slo: 'sk', slk: 'sk',
  tib: 'bo', bod: 'bo', wel: 'cy', cym: 'cy',

  afr: 'af', ara: 'ar', ben: 'bn', bul: 'bg', cat: 'ca', dan: 'da',
  eng: 'en', est: 'et', fin: 'fi', glg: 'gl', heb: 'he', hin: 'hi',
  hrv: 'hr', hun: 'hu', ind: 'id', ita: 'it', jpn: 'ja', kor: 'ko',
  lav: 'lv', lit: 'lt', nor: 'no', pol: 'pl', por: 'pt', rus: 'ru',
  slv: 'sl', spa: 'es', srp: 'sr', swe: 'sv', tam: 'ta', tel: 'te',
  tgl: 'tl', tha: 'th', tur: 'tr', ukr: 'uk', urd: 'ur', vie: 'vi',
}

/**
 * ffmpeg names an HLS audio rendition "audio_<n>" when var_stream_map does not
 * name it, and ours does not: that map is delimited by spaces and commas, so a
 * real title like "Portuguese (Brazil)" cannot be written into it at all. The
 * placeholder is worse than nothing in a menu, so it is discarded here.
 */
const FFMPEG_PLACEHOLDER = /^audio_\d+$/

/** "por" + "pt-BR" → "Português". Returns null when nothing can name it. */
export function languageLabel(code: string, locale: string): string | null {
  const normalized = code.trim().toLowerCase().replace(/_/g, '-')
  if (!normalized || normalized === 'und') return null
  const [base, ...rest] = normalized.split('-')
  const tag = [THREE_TO_TWO[base] ?? base, ...rest].join('-')
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(tag)
    // Intl echoes the tag back when it has no name for it, which would put a
    // bare "cat" in the menu where a language belongs.
    if (!name || name.toLowerCase() === tag.toLowerCase()) return null
    return name.charAt(0).toUpperCase() + name.slice(1)
  } catch {
    return null
  }
}

/**
 * What one entry of the audio menu reads. The language is the real signal —
 * ffmpeg writes it faithfully — so it wins over a name the encoder invented,
 * and the position is the last resort.
 */
export function audioTrackLabel(
  track: { name?: string; lang?: string },
  locale: string,
  index: number,
): string {
  const name = track.name?.trim()
  if (name && !FFMPEG_PLACEHOLDER.test(name)) return name
  if (track.lang) return languageLabel(track.lang, locale) ?? track.lang
  return String(index + 1)
}
