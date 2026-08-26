// The invite, handed in by the image build the way the commit is. Empty is a
// deployment that has no server to point at, and the header simply carries
// nothing rather than a link that goes nowhere.
const INVITE = (import.meta.env.VITE_DISCORD_URL as string | undefined)?.trim() ?? ''

// Only a real Discord invite is rendered. The value travels from a .env file
// through a build arg, and a header that would open whatever ended up in that
// variable is worth one check.
function isInvite(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return parsed.hostname === 'discord.gg'
      || parsed.hostname === 'discord.com'
      || parsed.hostname.endsWith('.discord.com')
  } catch {
    return false
  }
}

// Brand marks were dropped from lucide, and the header already inlines
// GitHub's for the same reason. This is Discord's own mark.
function DiscordMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 12" fill="currentColor" aria-hidden="true">
      <path d="M13.55 1.01A13.2 13.2 0 0 0 10.28 0c-.15.25-.32.6-.44.87a12.3 12.3 0 0 0-3.68 0A9 9 0 0 0 5.72 0 13.2 13.2 0 0 0 2.44 1.02C.37 4.13-.19 7.16.09 10.15a13.3 13.3 0 0 0 4.03 2.03c.32-.44.61-.92.86-1.42-.47-.18-.92-.4-1.35-.66l.33-.26a9.5 9.5 0 0 0 8.08 0l.33.26c-.43.26-.88.48-1.35.66.25.5.54.97.86 1.42a13.3 13.3 0 0 0 4.03-2.03c.33-3.47-.56-6.47-2.36-9.14ZM5.34 8.31c-.79 0-1.44-.72-1.44-1.6 0-.89.63-1.61 1.44-1.61s1.46.72 1.44 1.6c0 .89-.64 1.61-1.44 1.61Zm5.32 0c-.79 0-1.44-.72-1.44-1.6 0-.89.63-1.61 1.44-1.61s1.45.72 1.44 1.6c0 .89-.63 1.61-1.44 1.61Z" />
    </svg>
  )
}

/** Where the people watching together actually talk. */
export function DiscordLink({ label }: { label: string }) {
  if (!isInvite(INVITE)) return null
  return (
    <a
      className="header-discord"
      href={INVITE}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={label}
      title={label}
    >
      <DiscordMark />
    </a>
  )
}
