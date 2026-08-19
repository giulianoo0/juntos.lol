// Gecko is the one engine that cannot play what this pipeline produces: it has
// no HEVC path through Media Source Extensions, and HEVC is copied rather than
// transcoded, so those rooms stay black. Chromium and WebKit both decode it.
export function isUnsupportedBrowser(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox/')
}
