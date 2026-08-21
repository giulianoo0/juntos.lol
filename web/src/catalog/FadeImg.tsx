import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react'

// An image that never pops in: transparent until the bytes are decoded, then
// a short fade. Swapping `src` fades out first and back in with the new
// picture, so hero and thumbnail changes read as one soft exchange.
export function FadeImg({ src, className, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const [shown, setShown] = useState<string | undefined>(undefined)
  const imgRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    if (!src || typeof src !== 'string') {
      setShown(undefined)
      return
    }
    let cancelled = false
    const loader = new Image()
    loader.onload = () => { if (!cancelled) setShown(src) }
    loader.src = src
    // Cached images resolve synchronously-ish; complete avoids a blank frame.
    if (loader.complete) setShown(src)
    return () => { cancelled = true }
  }, [src])

  return (
    <img
      ref={imgRef}
      {...props}
      src={shown}
      className={`fade-img ${shown ? 'is-loaded' : ''} ${className ?? ''}`}
    />
  )
}
