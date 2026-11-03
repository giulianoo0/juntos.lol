import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SettingGroup } from '../player/Settings'
import { TrackPanel } from './TrackPanel'

function groups(onSubtitle = vi.fn(), onAudio = vi.fn()): SettingGroup[] {
  return [
    { id: 'subtitles', tab: 'subtitles', label: 'Legendas', current: 0, onPick: onSubtitle, options: [{ value: -1, label: 'Desligadas' }, { value: 0, label: 'Português' }, { value: 1, label: 'English' }] },
    { id: 'subtitleDelay', tab: 'subtitles', label: 'Atraso', current: 0, onPick: vi.fn(), options: [] },
    { id: 'audio', tab: 'audio', label: 'Faixa', current: 0, onPick: onAudio, options: [{ value: 0, label: 'Português' }, { value: 1, label: 'English' }] },
  ]
}

describe('TrackPanel', () => {
  it('abre focado na legenda atual e deixa de fora o que não tem opções', () => {
    render(<TrackPanel groups={groups()} onClose={vi.fn()} />)
    const subtitles = screen.getByRole('region', { name: 'Legendas' })
    expect(within(subtitles).getByRole('button', { name: 'Português' })).toHaveFocus()
    expect(within(subtitles).getByRole('button', { name: 'Português' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('region', { name: 'Atraso' })).toBeNull()
  })

  it('OK numa faixa de áudio escolhe essa faixa no player', () => {
    const onAudio = vi.fn()
    render(<TrackPanel groups={groups(vi.fn(), onAudio)} onClose={vi.fn()} />)
    fireEvent.click(within(screen.getByRole('region', { name: 'Faixa' })).getByRole('button', { name: 'English' }))
    expect(onAudio).toHaveBeenCalledWith(1)
  })
})
