/**
 * Whether this is Gecko (Firefox). Its compositor re-rasterises backdrop
 * filters, animated filters and text-clipped shimmers on every frame the
 * page changes, and a playing video changes it 24 times a second or more;
 * the stylesheet reads the verdict off `<html data-engine>` and flattens
 * those surfaces there. Blink keeps every effect.
 */
export function detectGecko(userAgent: string, supports: (property: string, value: string) => boolean): boolean {
  // Blink and WebKit say "like Gecko"; only Gecko carries a build token.
  if (/\bGecko\/\d/.test(userAgent)) return true
  try {
    return supports('-moz-appearance', 'none')
  } catch {
    return false
  }
}

export const isGecko: boolean = typeof navigator !== 'undefined'
  && detectGecko(navigator.userAgent, (property, value) =>
    typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports(property, value))

/**
 * Rolling digits animate registered custom properties, which Gecko runs on
 * the main thread for every tick of a clock; they change in place there.
 */
export const numbersAnimate = !isGecko

export function markEngine(root: HTMLElement = document.documentElement): void {
  if (isGecko) root.dataset.engine = 'gecko'
}
