import { describe, expect, it } from 'vitest'
import { dragsWindow } from './AppChrome'

function header(): HTMLElement {
  const root = document.createElement('header')
  root.setAttribute('data-tauri-drag-region', '')
  root.innerHTML = '<div class="title"><span>Sala</span></div><button><svg></svg></button><a href="/">juntos</a>'
  return root
}

describe('dragsWindow', () => {
  it('moves the window from anything inside the header that is not a control', () => {
    const root = header()
    expect(dragsWindow(root.querySelector('span')!)).toBe(true)
    expect(dragsWindow(root.querySelector('.title')!)).toBe(true)
  })

  it('leaves the controls and the header itself alone, which Tauri already drags', () => {
    const root = header()
    expect(dragsWindow(root.querySelector('svg')!)).toBe(false)
    expect(dragsWindow(root.querySelector('a')!)).toBe(false)
    expect(dragsWindow(root)).toBe(false)
    expect(dragsWindow(document.createElement('div'))).toBe(false)
  })
})
