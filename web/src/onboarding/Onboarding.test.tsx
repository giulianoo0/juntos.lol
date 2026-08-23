import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Onboarding } from './Onboarding'
import { hasSeenOnboarding } from './seen'

// The sounds are a click handler talking to WebAudio, which jsdom has none of.
// What matters here is that a click makes one, not what it sounds like.
vi.mock('./sounds', () => ({
  playAdvance: vi.fn(),
  playBack: vi.fn(),
  playFinish: vi.fn(),
}))

const { playAdvance, playFinish } = await import('./sounds')

const next = () => screen.getByRole('button', { name: /avançar|next/i })

describe('hasSeenOnboarding', () => {
  beforeEach(() => localStorage.clear())

  it('is false before it has ever run', () => {
    expect(hasSeenOnboarding()).toBe(false)
  })

  it('is true once the last step was reached', async () => {
    render(<Onboarding />)
    await userEvent.click(next())
    await userEvent.click(next())
    await userEvent.click(screen.getByRole('button', { name: /começar|start/i }))
    expect(hasSeenOnboarding()).toBe(true)
  })

  it('is true when skipped, because skipping is an answer', async () => {
    render(<Onboarding />)
    await userEvent.click(screen.getByRole('button', { name: /pular|skip/i }))
    expect(hasSeenOnboarding()).toBe(true)
  })
})

describe('Onboarding', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('opens on what the app is, before either tab is explained', async () => {
    render(<Onboarding />)
    expect(await screen.findByRole('heading', { name: /assistir junto|watch together/i })).toBeInTheDocument()
  })

  it('explains the room tab, and says the torrent is downloaded by ss-bridge', async () => {
    render(<Onboarding />)
    await userEvent.click(next())
    expect(await screen.findByRole('heading', { name: /sala|room/i })).toBeInTheDocument()
    expect(screen.getByText(/baixado pelo ss-bridge|downloaded by ss-bridge/i)).toBeInTheDocument()
  })

  it('explains that the catalogue finds nothing without a plugin', async () => {
    render(<Onboarding />)
    await userEvent.click(next())
    await userEvent.click(next())
    expect(await screen.findByRole('heading', { name: /catálogo|catalogue/i })).toBeInTheDocument()
    expect(screen.getByText(/lista tudo e não abre nada|lists everything and opens nothing/i)).toBeInTheDocument()
  })

  it('goes back to the step before', async () => {
    render(<Onboarding />)
    await userEvent.click(next())
    await userEvent.click(screen.getByRole('button', { name: /voltar|back/i }))
    expect(await screen.findByRole('heading', { name: /assistir junto|watch together/i })).toBeInTheDocument()
  })

  it('makes a sound on the click, never on its own', async () => {
    render(<Onboarding />)
    // Rendering alone is silent: a browser would refuse to play before a
    // gesture anyway, and unannounced sound is worse than none.
    expect(playAdvance).not.toHaveBeenCalled()
    await userEvent.click(next())
    expect(playAdvance).toHaveBeenCalledOnce()
  })

  it('sounds the end differently from a step', async () => {
    render(<Onboarding />)
    await userEvent.click(next())
    await userEvent.click(next())
    await userEvent.click(screen.getByRole('button', { name: /começar|start/i }))
    expect(playFinish).toHaveBeenCalledOnce()
  })

  it('leaves on Escape, for somebody who already knows the app', async () => {
    const onDone = vi.fn()
    render(<Onboarding onDone={onDone} />)
    await userEvent.keyboard('{Escape}')
    expect(onDone).toHaveBeenCalledOnce()
    expect(hasSeenOnboarding()).toBe(true)
  })
})
