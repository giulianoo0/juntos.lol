import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AvatarEditor } from './AvatarEditor'

function Controlled({ start, onChange }: { start: string; onChange: (value: string) => void }) {
  const [value, setValue] = useState(start)
  return <AvatarEditor value={value} onChange={(next) => { setValue(next); onChange(next) }} />
}

describe('AvatarEditor', () => {
  beforeEach(() => localStorage.setItem('ss.language', 'pt-BR'))

  it('monta o avatar pelo bicho, pela cor e pelo acessório', () => {
    const onChange = vi.fn()
    render(<Controlled start="cat.bowtie" onChange={onChange} />)

    fireEvent.click(screen.getByRole('radio', { name: 'Preto' }))
    expect(onChange).toHaveBeenLastCalledWith('cat-preto.bowtie')
    fireEvent.click(screen.getByRole('radio', { name: 'Coroa' }))
    expect(onChange).toHaveBeenLastCalledWith('cat-preto.crown')
    // A raposa não tem preto: a cor cai, o acessório fica.
    fireEvent.click(screen.getByRole('radio', { name: 'Raposa' }))
    expect(onChange).toHaveBeenLastCalledWith('fox.crown')
    fireEvent.click(screen.getByRole('radio', { name: 'Nenhum' }))
    expect(onChange).toHaveBeenLastCalledWith('fox')
    expect(screen.getByRole('radio', { name: 'Raposa' })).toHaveAttribute('aria-checked', 'true')
  })
})
