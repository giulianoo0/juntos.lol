import { describe, expect, it, vi } from 'vitest'
import { latestDesktopRelease, pickAndroid, pickRelease } from './desktopRelease'

const asset = (name: string) => ({ name, browser_download_url: `https://github.com/x/${name}` })

describe('pickRelease', () => {
  it('takes the newest desktop release and skips the site, drafts and prereleases', () => {
    const release = pickRelease([
      { tag_name: 'v2026.10', draft: false, prerelease: false, assets: [asset('site.zip')] },
      { tag_name: 'desktop-v0.3.0', draft: true, prerelease: false, assets: [asset('Juntos.dmg')] },
      { tag_name: 'desktop-v0.2.1-beta', draft: false, prerelease: true, assets: [asset('Juntos.dmg')] },
      { tag_name: 'desktop-v0.2.0', draft: false, prerelease: false, assets: [asset('Juntos.dmg'), asset('Juntos-setup.exe'), asset('Juntos.AppImage'), asset('latest.json')] },
      { tag_name: 'desktop-v0.1.0', draft: false, prerelease: false, assets: [asset('Juntos.dmg')] },
    ])
    expect(release).toEqual({
      version: '0.2.0',
      downloads: {
        mac: 'https://github.com/x/Juntos.dmg',
        windows: 'https://github.com/x/Juntos-setup.exe',
        linux: 'https://github.com/x/Juntos.AppImage',
      },
    })
  })

  it('leaves out a platform whose file is missing', () => {
    expect(pickRelease([{ tag_name: 'desktop-v0.1.0', draft: false, prerelease: false, assets: [asset('Juntos.dmg')] }]))
      .toEqual({ version: '0.1.0', downloads: { mac: 'https://github.com/x/Juntos.dmg' } })
  })

  it('is null before the first desktop release', () => {
    expect(pickRelease([{ tag_name: 'v1', draft: false, prerelease: false, assets: [] }])).toBeNull()
  })
})

describe('pickAndroid', () => {
  it('takes the apk of the fixed android prerelease, beside the desktop ones', () => {
    expect(pickAndroid([
      { tag_name: 'desktop-v0.2.5', draft: false, prerelease: false, assets: [asset('Juntos.dmg')] },
      { tag_name: 'android', name: 'Android 0.1.0 beta', draft: false, prerelease: true, assets: [asset('latest.json'), asset('juntos.apk')] },
    ])).toEqual({ version: '0.1.0', url: 'https://github.com/x/juntos.apk' })
  })

  it('is null before the first apk, or while the release is a draft', () => {
    expect(pickAndroid([{ tag_name: 'android', draft: false, prerelease: true, assets: [asset('latest.json')] }])).toBeNull()
    expect(pickAndroid([{ tag_name: 'android', draft: true, prerelease: true, assets: [asset('juntos.apk')] }])).toBeNull()
  })
})

describe('latestDesktopRelease', () => {
  it('asks again after a failure', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json([]))
    await expect(latestDesktopRelease(fetcher)).rejects.toThrow('github 503')
    await expect(latestDesktopRelease(fetcher)).resolves.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
