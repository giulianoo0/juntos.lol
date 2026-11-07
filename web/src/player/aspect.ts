/** How the picture fills the player: as made, cropped to fill, stretched, or forced to a ratio. */
export type Aspect = 'original' | 'fill' | 'stretch' | '16:9' | '4:3' | '21:9'

export const ASPECTS: readonly Aspect[] = ['original', 'fill', 'stretch', '16:9', '4:3', '21:9']

const RATIOS: Partial<Record<Aspect, number>> = { '16:9': 16 / 9, '4:3': 4 / 3, '21:9': 21 / 9 }

const STORAGE_KEY = 'ss.aspect'

/**
 * The scale that turns the `object-fit: contain` picture into the chosen one.
 * The element keeps its box, so the subtitle layers stay on the contained picture.
 */
export function aspectScale(aspect: Aspect, box: { width: number; height: number }, video: { width: number; height: number }): { x: number; y: number } {
  if (aspect === 'original' || !box.width || !box.height || !video.width || !video.height) return { x: 1, y: 1 }
  const fit = Math.min(box.width / video.width, box.height / video.height)
  const shownWidth = video.width * fit
  const shownHeight = video.height * fit
  if (aspect === 'fill') {
    const cover = Math.max(box.width / shownWidth, box.height / shownHeight)
    return { x: cover, y: cover }
  }
  if (aspect === 'stretch') return { x: box.width / shownWidth, y: box.height / shownHeight }
  const ratio = RATIOS[aspect] ?? video.width / video.height
  const width = Math.min(box.width, box.height * ratio)
  return { x: width / shownWidth, y: width / ratio / shownHeight }
}

export function savedAspect(): Aspect {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return ASPECTS.includes(saved as Aspect) ? (saved as Aspect) : 'original'
  } catch {
    return 'original'
  }
}

export function saveAspect(aspect: Aspect): void {
  try {
    if (aspect === 'original') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, aspect)
  } catch {
    // The choice lasts for this page only.
  }
}
