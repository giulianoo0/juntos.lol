import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { translate, type Translator } from '../i18n/useT'
import { YoutubePicker } from './YoutubePicker'

vi.mock('../youtube', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../youtube')>()),
  openYoutube: vi.fn(() => new Promise(() => {})),
  youtubeCapacity: vi.fn(async () => 'available'),
}))

const t = Object.assign((key: string) => translate('pt-BR', key), {
  language: 'pt-BR' as const,
  setLanguage: vi.fn(),
}) as Translator

describe('YoutubePicker while the link is read', () => {
  it('keeps the button words, marks it working and holds the place of the video', async () => {
    render(<YoutubePicker onPicked={vi.fn()} t={t} initialUrl="https://youtube.com/watch?v=dQw4w9WgXcQ" />)
    fireEvent.click(screen.getByRole('button', { name: 'Buscar vídeo' }))
    const button = await screen.findByRole('button', { name: 'Buscar vídeo' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toBeDisabled()
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
  })
})
