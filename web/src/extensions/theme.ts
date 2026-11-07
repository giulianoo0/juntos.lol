/**
 * The juntos tokens an extension gets to dress in: resolved values, never
 * references it could not resolve on its own origin. Long values (fonts,
 * linear() springs) stay home; the protocol caps a value at 64 chars.
 */
import { useEffect, useState } from 'react'
import type { ThemeTokens } from './protocol'

const SHARED = [
  '--text', '--text-muted', '--text-faint',
  '--primary', '--primary-hover', '--on-primary', '--focus', '--danger',
  '--frame-ground', '--frame-side', '--surface', '--surface-2', '--surface-3', '--overlay', '--field',
  '--line', '--line-strong', '--hover', '--hover-strong',
  '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl', '--radius-full',
  '--ease-out', '--ease-in-out', '--duration-fast', '--duration-base',
]

const SAFE_VALUE = /^[^;{}<>]{1,64}$/

function currentMode(): ThemeTokens['mode'] {
  const set = document.documentElement.dataset.theme
  if (set === 'light' || set === 'dark') return set
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function themeTokens(): ThemeTokens {
  const style = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const name of SHARED) {
    const value = style.getPropertyValue(name).trim()
    if (SAFE_VALUE.test(value)) vars[name] = value
  }
  return { mode: currentMode(), vars }
}

/** The tokens, read again whenever the page's theme flips. */
export function useThemeTokens(): ThemeTokens {
  const [tokens, setTokens] = useState(themeTokens)
  useEffect(() => {
    const read = () => setTokens(themeTokens())
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const scheme = window.matchMedia?.('(prefers-color-scheme: light)')
    scheme?.addEventListener('change', read)
    return () => { observer.disconnect(); scheme?.removeEventListener('change', read) }
  }, [])
  return tokens
}
