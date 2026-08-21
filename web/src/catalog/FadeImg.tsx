import { useEffect, useMemo, useState, type ImgHTMLAttributes } from 'react'

// A deterministic two-tone gradient stands in while the bytes arrive — the
// hue comes from the URL, so each title waits under its own colour instead
// of a flat grey box. It also stays if the URL turns out to be dead.
function placeholderGradient(src: string): string {
  let hash = 0
  for (let index = 0; index < src.length; index += 1) {
    hash = (hash * 31 + src.charCodeAt(index)) | 0
  }
  const hue = ((hash % 360) + 360) % 360
  return `linear-gradient(140deg, hsl(${hue} 32% 24%), hsl(${(hue + 46) % 360} 30% 13%))`
}

// An image that never pops in: its colour placeholder shows until the bytes
// are decoded, then the picture fades over it. Swapping `src` fades out and
// back in with the new picture, so hero and thumbnail changes stay soft.
export function FadeImg({ src, className, style, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const [shown, setShown] = useState<string | undefined>(undefined)
  const gradient = useMemo(() => (typeof src === 'string' && src ? placeholderGradient(src) : undefined), [src])

  useEffect(() => {
    if (!src || typeof src !== 'string') {
      setShown(undefined)
      return
    }
    let cancelled = false
    const loader = new Image()
    loader.onload = () => { if (!cancelled) setShown(src) }
    // On error the placeholder colours simply stay — a permanently empty box
    // is worse than an honest tint.
    loader.src = src
    // Cached images resolve synchronously-ish; complete avoids a blank frame.
    if (loader.complete && loader.naturalWidth > 0) setShown(src)
    return () => {
      cancelled = true
      loader.onload = null
    }
  }, [src])

  // The gradient lives on a wrapper: the img itself sits at opacity 0 until
  // decoded, and a background on an invisible element would be invisible too.
  return (
    <span className={`fade-frame ${className ?? ''}`} style={{ ...style, background: gradient }}>
      <img {...props} alt={props.alt ?? ''} src={shown} className={`fade-img ${shown ? 'is-loaded' : ''}`} />
    </span>
  )
}
