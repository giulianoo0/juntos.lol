export type Route =
  | { kind: 'root' }
  | { kind: 'sdk' }
  | { kind: 'media' }
  | { kind: 'file'; version: string; path: string }

export const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  woff2: 'font/woff2',
  ico: 'image/x-icon',
}

const VERSION = /^[0-9a-f]{40}$/
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._@+-]{0,127}$/

export function contentTypeFor(path: string): string | null {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? null : (CONTENT_TYPES[path.slice(dot + 1)] ?? null)
}

export function route(pathname: string): Route | null {
  if (pathname === '/') return { kind: 'root' }
  if (pathname === '/_juntos/sdk.js') return { kind: 'sdk' }
  if (pathname === '/_juntos/media') return { kind: 'media' }
  const m = /^\/@([^/]+)\/(.+)$/.exec(pathname)
  if (!m || !VERSION.test(m[1])) return null
  const segments: string[] = []
  for (const raw of m[2].split('/')) {
    let seg: string
    try {
      seg = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (!SEGMENT.test(seg) || seg.includes('..')) return null
    segments.push(seg)
  }
  const path = segments.join('/')
  return contentTypeFor(path) ? { kind: 'file', version: m[1], path } : null
}
