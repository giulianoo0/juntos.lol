import { useEffect, useState } from 'react'
import type { ExtensionPlace } from './extensions/protocol'

/** What the server tells every page: identifiers, never secrets. Empty means off. */
export interface PublicConfig {
  turnstileSiteKey: string
  discordAppId: string
  /** Where extensions live, one subdomain each: `santamagia.com` in production. */
  extensionBase?: string
  extensionScheme?: string
  extensionRaw?: string
  /** Extension ids every device installs on its own. */
  extensionDefaults?: string[]
}

let loaded: Promise<PublicConfig> | null = null

export function loadPublicConfig(): Promise<PublicConfig> {
  loaded ??= fetch('/api/config').then(async (response) => {
    if (!response.ok) throw new Error('config')
    return await response.json() as PublicConfig
  }).catch((error: unknown) => {
    loaded = null
    throw error
  })
  return loaded
}

/** The server's config, null until it arrives (or when it could not be read). */
export function usePublicConfig(): PublicConfig | null {
  const [config, setConfig] = useState<PublicConfig | null>(null)
  useEffect(() => {
    let live = true
    void loadPublicConfig().then((found) => { if (live) setConfig(found) }).catch(() => undefined)
    return () => { live = false }
  }, [])
  return config
}

/** The ids the server installs everywhere, the valid ones. */
export function extensionDefaults(config: PublicConfig | null): string[] {
  const ids = config?.extensionDefaults
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && /^[a-z][a-z0-9-]{2,31}$/.test(id)) : []
}

/** The extensions' place from the config; undefined (production's) when it says nothing usable. */
export function extensionPlace(config: PublicConfig | null): ExtensionPlace | undefined {
  const base = config?.extensionBase
  const scheme = config?.extensionScheme
  if (!base || !/^[a-z0-9.-]+(:\d{1,5})?$/.test(base) || (scheme !== 'https' && scheme !== 'http')) return undefined
  const raw = config?.extensionRaw
  return raw && /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?(\/(?!\.+(\/|$))[A-Za-z0-9._~-]+)*$/.test(raw) ? { base, scheme, raw } : { base, scheme }
}
