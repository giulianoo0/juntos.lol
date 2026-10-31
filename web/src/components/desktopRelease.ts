export type Platform = 'mac' | 'windows' | 'linux'

export type DesktopRelease = {
  version: string
  downloads: Partial<Record<Platform, string>>
}

const RELEASES_API = 'https://api.github.com/repos/giulianoo0/juntos.lol/releases?per_page=20'
const ANDROID_API = 'https://api.github.com/repos/giulianoo0/juntos.lol/releases/tags/android'
const TAG = /^desktop-v(\d+\.\d+\.\d+.*)$/

const FILES: Record<Platform, RegExp> = {
  mac: /\.dmg$/i,
  windows: /\.exe$/i,
  linux: /\.AppImage$/i,
}

type GithubRelease = {
  tag_name: string
  name?: string
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

let pending: Promise<GithubRelease[]> | null = null

/** Asked once per page; a failure is forgotten so the next opening tries again. */
function githubReleases(fetcher: typeof fetch): Promise<GithubRelease[]> {
  pending ??= fetcher(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
    .then(async (response) => {
      if (!response.ok) throw new Error(`github ${response.status}`)
      return await response.json() as GithubRelease[]
    })
    .catch((error: unknown) => {
      pending = null
      throw error
    })
  return pending
}

export function latestDesktopRelease(fetcher: typeof fetch = fetch): Promise<DesktopRelease | null> {
  return githubReleases(fetcher).then(pickRelease)
}

export type AndroidRelease = {
  version: string | null
  url: string
}

/** The apk lives in one prerelease of fixed tag, replaced at each version, so the app's updater has a stable address. */
export function pickAndroid(release: GithubRelease): AndroidRelease | null {
  const apk = release.assets.find(({ name }) => name === 'juntos.apk')
  if (release.draft || !apk) return null
  return { version: /\d+\.\d+\.\d+/.exec(release.name ?? '')?.[0] ?? null, url: apk.browser_download_url }
}

/** Asked by its tag: an old release, it would fall off the newest desktop ones. */
export async function latestAndroidRelease(fetcher: typeof fetch = fetch): Promise<AndroidRelease | null> {
  const response = await fetcher(ANDROID_API, { headers: { Accept: 'application/vnd.github+json' } })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`github ${response.status}`)
  return pickAndroid(await response.json() as GithubRelease)
}
