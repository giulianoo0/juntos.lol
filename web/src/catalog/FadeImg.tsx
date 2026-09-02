import { useEffect, useMemo, useState, type ImgHTMLAttributes } from 'react'

// Deterministic in the URL, so each title waits under its own colour.
function placeholderGradient(src: string): string {
  let hash = 0
  for (let index = 0; index < src.length; index += 1) {
    hash = (hash * 31 + src.charCodeAt(index)) | 0
  }
  const hue = ((hash % 360) + 360) % 360
  return `linear-gradient(140deg, hsl(${hue} 32% 24%), hsl(${(hue + 46) % 360} 30% 13%))`
}

// An image that never pops in: the colour placeholder holds the frame until the
// bytes decode, then the picture fades over it. `overlay` drops the placeholder,
// for an image stacked over another; `onReady` must be a stable reference.
export function FadeImg({ src, className, style, overlay = false, onReady, ...props }: ImgHTMLAttributes<HTMLImageElement> & { overlay?: boolean; onReady?: () => void }) {
  const [shown, setShown] = useState<string | undefined>(undefined)
  const lazy = props.loading === 'lazy'
  const gradient = useMemo(
    () => (!overlay && typeof src === 'string' && src ? placeholderGradient(src) : undefined),
    [src, overlay],
  )

  useEffect(() => {
    if (lazy) return
    if (!src || typeof src !== 'string') {
      setShown(undefined)
      return
    }
    let cancelled = false
    const loader = new Image()
    loader.onload = () => { if (!cancelled) { setShown(src); onReady?.() } }
    loader.src = src
    if (loader.complete && loader.naturalWidth > 0) { setShown(src); onReady?.() }
    return () => {
      cancelled = true
      loader.onload = null
    }
  }, [src, lazy, onReady])

  return (
    <span className={`fade-frame ${className ?? ''}`} style={{ ...style, background: gradient }}>
      {lazy ? (
        <img
          {...props}
          alt={props.alt ?? ''}
          src={src}
          decoding="async"
          onLoad={() => { setShown(typeof src === 'string' ? src : undefined); onReady?.() }}
          className={`fade-img ${shown === src ? 'is-loaded' : ''}`}
        />
      ) : (
        <img {...props} alt={props.alt ?? ''} src={shown} decoding="async" className={`fade-img ${shown ? 'is-loaded' : ''}`} />
      )}
    </span>
  )
}
