import { useState } from 'react'

export type Theme = 'system' | 'light' | 'dark'

const KEY = 'ss.theme'

function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

/** Puts the saved theme on `<html>` (`data-theme`); none follows the system. */
export function applyTheme(theme: Theme = savedTheme()): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.dataset.theme = theme
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(savedTheme)
  const setTheme = (next: Theme) => {
    try {
      if (next === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
    } catch {}
    applyTheme(next)
    setThemeState(next)
  }
  return { theme, setTheme }
}
