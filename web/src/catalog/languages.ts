// Torrentio speaks in flag emojis; the filter wants readable names. Map each
// flag to the language it stands for, then let Intl name it in the UI locale.
const FLAG_TO_LANGUAGE: Record<string, string> = {
  '🇧🇷': 'pt', '🇵🇹': 'pt', '🇬🇧': 'en', '🇺🇸': 'en', '🇪🇸': 'es', '🇲🇽': 'es',
  '🇫🇷': 'fr', '🇩🇪': 'de', '🇮🇹': 'it', '🇷🇺': 'ru', '🇯🇵': 'ja', '🇰🇷': 'ko',
  '🇨🇳': 'zh', '🇮🇳': 'hi', '🇸🇦': 'ar', '🇳🇱': 'nl', '🇵🇱': 'pl', '🇹🇷': 'tr',
  '🇸🇪': 'sv', '🇳🇴': 'no', '🇩🇰': 'da', '🇫🇮': 'fi', '🇭🇺': 'hu', '🇨🇿': 'cs',
  '🇬🇷': 'el', '🇮🇱': 'he', '🇹🇭': 'th', '🇻🇳': 'vi', '🇮🇩': 'id', '🇲🇾': 'ms',
  '🇺🇦': 'uk', '🇧🇬': 'bg', '🇷🇸': 'sr', '🇭🇷': 'hr', '🇷🇴': 'ro', '🇸🇰': 'sk',
  '🇱🇹': 'lt', '🇱🇻': 'lv', '🇪🇪': 'et',
}

// "🇧🇷" + "pt-BR" → "Português". Unknown flags fall back to the country name
// ("Islândia" beats an empty label), and failing even that, the flag alone.
export function languageName(flag: string, locale: string): string {
  try {
    const language = FLAG_TO_LANGUAGE[flag]
    if (language) {
      const name = new Intl.DisplayNames([locale], { type: 'language' }).of(language)
      if (name) return name.charAt(0).toUpperCase() + name.slice(1)
    }
    const region = [...flag].map((char) => {
      const codePoint = char.codePointAt(0) ?? 0
      return String.fromCharCode(codePoint - 0x1f1e6 + 65)
    }).join('')
    const name = new Intl.DisplayNames([locale], { type: 'region' }).of(region)
    return name ?? flag
  } catch {
    return flag
  }
}
