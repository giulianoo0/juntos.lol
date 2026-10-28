import { useEffect, useState } from 'react'

/** What the server tells every page: identifiers, never secrets. Empty means off. */
export interface PublicConfig {
  turnstileSiteKey: string
  discordAppId: string
  catalogAddonUrl: string
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
