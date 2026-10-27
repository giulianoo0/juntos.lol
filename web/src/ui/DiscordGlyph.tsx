import type { SVGProps } from 'react'

/** Discord's mark, in the current color. */
export function DiscordGlyph({ size = 18, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size * 0.75} viewBox="0 0 24 18" aria-hidden="true" {...rest}>
      <path
        fill="currentColor"
        d="M20.3 1.5A19.6 19.6 0 0 0 15.4 0l-.6 1.3a18 18 0 0 0-5.6 0L8.6 0a19.6 19.6 0 0 0-4.9 1.5C.6 6.2-.3 10.7.1 15.2a19.8 19.8 0 0 0 6 3l1.3-2a12.7 12.7 0 0 1-2-1l.5-.4a14 14 0 0 0 12.1 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.7 19.7 0 0 0 6-3c.5-5.2-.8-9.7-3.5-13.7ZM8 12.4c-1.2 0-2.2-1.1-2.2-2.4S6.8 7.6 8 7.6s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z"
      />
    </svg>
  )
}
