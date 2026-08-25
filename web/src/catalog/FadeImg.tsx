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
//
// `overlay` drops the colour placeholder: the frame stays transparent until
// the picture arrives, for an image stacked over another that must crossfade
// in rather than blot out what it is covering.
export function FadeImg({ src, className, style, overlay = false, ...props }: ImgHTMLAttributes<HTMLImageElement> & { overlay?: boolean }) {
  const [shown, setShown] = useState<string | undefined>(undefined)
  // A detached loader is not in the document, so `loading="lazy"` on the img
  // below gated nothing: the bytes were already downloaded by the time the
  // element got a src. Two hundred posters are mounted at once in the catalog
  // and six of them are on screen. Where the caller asked for lazy, the
  // browser's own gate does the work and the fade rides the img's own load.
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
  }, [src, lazy])

  // The gradient lives on a wrapper: the img itself sits at opacity 0 until
  // decoded, and a background on an invisible element would be invisible too.
  return (
    <span className={`fade-frame ${className ?? ''}`} style={{ ...style, background: gradient }}>
      {lazy ? (
        <img
          {...props}
          alt={props.alt ?? ''}
          src={src}
          decoding="async"
          onLoad={() => setShown(typeof src === 'string' ? src : undefined)}
          className={`fade-img ${shown === src ? 'is-loaded' : ''}`}
        />
      ) : (
        <img {...props} alt={props.alt ?? ''} src={shown} decoding="async" className={`fade-img ${shown ? 'is-loaded' : ''}`} />
      )}
    </span>
  )
}
