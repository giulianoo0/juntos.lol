import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The invite is read at module load, so each case needs a fresh import.
async function linkWith(url: string | undefined) {
  vi.resetModules()
  vi.stubEnv('VITE_DISCORD_URL', url as string)
  const { DiscordLink } = await import('./DiscordLink')
  return DiscordLink
}

describe('DiscordLink', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('opens the deployment’s invite in a new tab', async () => {
    const DiscordLink = await linkWith('https://discord.gg/mWcvyk4kPA')
    render(<DiscordLink label="Join the Discord" />)

    const link = screen.getByRole('link', { name: 'Join the Discord' })
    expect(link).toHaveAttribute('href', 'https://discord.gg/mWcvyk4kPA')
    expect(link).toHaveAttribute('target', '_blank')
    // Without this the invite hands window.opener to whatever it opens.
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('shows nothing when a deployment has no server of its own', async () => {
    const DiscordLink = await linkWith('')
    render(<DiscordLink label="Join the Discord" />)

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('refuses anything that is not a Discord invite', async () => {
    // The value travels from a .env file into the header's href, so a
    // mistyped or swapped one must not become a link the site vouches for.
    for (const bad of ['https://evil.test/x', 'javascript:alert(1)', 'http://discord.gg/x']) {
      const DiscordLink = await linkWith(bad)
      const { unmount } = render(<DiscordLink label="Join the Discord" />)
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
      unmount()
    }
  })
})
