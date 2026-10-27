import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'

describe('Button', () => {
  it('working, keeps its words, holds still and says it is busy', () => {
    render(<Button variant="primary" loading>Compartilhar</Button>)
    const button = screen.getByRole('button', { name: 'Compartilhar' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toBeDisabled()
  })
})
