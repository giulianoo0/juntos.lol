export type Platform = 'mac' | 'windows' | 'linux'

export type DesktopRelease = {
  version: string
  downloads: Partial<Record<Platform, string>>
}

const RELEASES_API = 'https://api.github.com/repos/giulianoo0/juntos.lol/releases?per_page=20'
const TAG = /^desktop-v(\d+\.\d+\.\d+.*)$/

const FILES: Record<Platform, RegExp> = {
  mac: /\.dmg$/i,
  windows: /\.exe$/i,
  linux: /\.AppImage$/i,
}

type GithubRelease = {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: { name: string, browser_download_url: string }[]
}

/** The newest published desktop release among the repo's releases (the site has others), or null when none is out yet. */
export function pickRelease(releases: GithubRelease[]): DesktopRelease | null {
  for (const release of releases) {
    const version = TAG.exec(release.tag_name)?.[1]
    if (!version || release.draft || release.prerelease) continue
    const downloads: DesktopRelease['downloads'] = {}
    for (const platform of Object.keys(FILES) as Platform[]) {
      const asset = release.assets.find(({ name }) => FILES[platform].test(name))
      if (asset) downloads[platform] = asset.browser_download_url
    }
    return { version, downloads }
  }
  return null
}

let pending: Promise<DesktopRelease | null> | null = null

/** Asked once per page; a failure is forgotten so the next opening tries again. */
export function latestDesktopRelease(fetcher: typeof fetch = fetch): Promise<DesktopRelease | null> {
  pending ??= fetcher(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
    .then(async (response) => {
      if (!response.ok) throw new Error(`github ${response.status}`)
      return pickRelease(await response.json() as GithubRelease[])
    })
    .catch((error: unknown) => {
      pending = null
      throw error
    })
  return pending
}
