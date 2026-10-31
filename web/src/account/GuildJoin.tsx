/**
 * Sends an account that signed in before the juntos server was asked for to
 * Discord, once, so its callback puts the person in the server. Never from
 * inside a room, and never for nobody.
 */
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { askGuildJoin, discordLoginUrl, useMe } from '../account'

const assign = (url: string) => window.location.assign(url)

export function GuildJoin({ leave = assign }: { leave?: (url: string) => void }) {
  const { me } = useMe()
  const { pathname, search } = useLocation()
  const asked = useRef(false)
  const pending = me?.guildPending === true && !pathname.startsWith('/room/')

  useEffect(() => {
    if (!pending || asked.current) return
    asked.current = true
    const back = pathname + search
    void askGuildJoin().then((go) => { if (go) leave(discordLoginUrl(back)) })
  }, [pending, pathname, search, leave])

  return null
}
