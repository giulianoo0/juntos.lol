import { Lock, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useT } from '../i18n/useT'
import { roomCodeFrom } from '../roomCode'
import { AvatarStack } from '../ui/Avatar'
import { Field } from '../ui/Field'
import { IconPill } from '../ui/IconPill'
import { Pill, PillLink } from '../ui/Pill'
import styles from './Home.module.css'

const DISCORD_INSTALL = 'https://discord.com/oauth2/authorize?client_id=1564358804206911529'

export interface CreateRoomInput {
  name: string
  password: string
}

const words = {
  'pt-BR': {
    title: 'Assistam juntos',
    roomName: 'Nome da sala',
    password: 'Senha',
    create: 'Criar sala',
    or: 'ou',
    code: 'Código',
    codeLabel: 'Código da sala',
    enter: 'Entrar',
    discord: 'Adicionar ao Discord',
    failed: 'Não deu para criar a sala. Tente de novo.',
  },
  en: {
    title: 'Watch together',
    roomName: 'Room name',
    password: 'Password',
    create: 'Create room',
    or: 'or',
    code: 'Code',
    codeLabel: 'Room code',
    enter: 'Join',
    discord: 'Add to Discord',
    failed: 'Could not create the room. Try again.',
  },
}

/* Faces of the hues, for the stack over the title. */
const FACES = [
  { id: 'giu', name: 'G' },
  { id: 'ana', name: 'A' },
  { id: 'bruno', name: 'B' },
  { id: 'caio', name: 'C' },
]

function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="12" r="5" />
      <circle cx="15" cy="12" r="5" />
    </svg>
  )
}

/**
 * The home: create a room (a name and, behind the lock, a password) or
 * enter one by its code. What a room shows is opened inside it, from
 * "Compartilhar".
 */
export function Home({ createRoom }: { createRoom: (input: CreateRoomInput) => Promise<{ roomID: string }> }) {
  const t = useT()
  const text = words[t.language]
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [withPassword, setWithPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const room = roomCodeFrom(code)

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const created = await createRoom({ name: name.trim(), password: withPassword ? password : '' })
      navigate(`/room/${created.roomID}`)
    } catch {
      setError(text.failed)
      setBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="/"><Mark />Juntos</a>
        <PillLink tone="soft" size="md" icon={<Plus size={15} />} href={DISCORD_INSTALL} target="_blank" rel="noopener noreferrer">
          {text.discord}
        </PillLink>
      </header>

      <main className={styles.main}>
        <div className={styles.hero}>
          <AvatarStack people={FACES} size={44} max={4} />
          <h1 className={styles.title}>{text.title}</h1>
        </div>

        <form className={styles.form} onSubmit={(event) => { void create(event) }}>
          <Field aria-label={text.roomName} placeholder={text.roomName} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          {withPassword ? (
            <div className={styles.reveal}>
              <Field
                type="password"
                aria-label={text.password}
                placeholder={text.password}
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          ) : null}
          <div className={styles.row}>
            <IconPill
              label={text.password}
              icon={<Lock size={16} />}
              active={withPassword}
              aria-pressed={withPassword}
              onClick={() => setWithPassword((on) => !on)}
            />
            <Pill type="submit" tone="primary" size="lg" block disabled={busy}>{text.create}</Pill>
          </div>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </form>

        <div className={styles.or} aria-hidden="true"><span />{text.or}<span /></div>

        <form className={styles.join} onSubmit={(event) => { event.preventDefault(); if (room) navigate(`/room/${room}`) }}>
          <Field mono aria-label={text.codeLabel} placeholder={text.code} value={code} spellCheck={false} autoCapitalize="characters" autoCorrect="off" onChange={(event) => setCode(event.target.value)} />
          <Pill type="submit" tone="soft" size="lg" disabled={!room}>{text.enter}</Pill>
        </form>
      </main>
    </div>
  )
}
