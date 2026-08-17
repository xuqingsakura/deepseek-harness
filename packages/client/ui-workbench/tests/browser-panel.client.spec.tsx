// @vitest-environment jsdom
/** Embedded browser panel: URL normalization and navigation controls. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/client/locales.ts'
import { normalizeBrowserUrl, WorkbenchBrowserPanel } from '../src/client/WorkbenchBrowserPanel.tsx'

afterEach(cleanup)

describe('normalizeBrowserUrl', () => {
  it('keeps explicit schemes and empty input', () => {
    expect(normalizeBrowserUrl('')).toBe('')
    expect(normalizeBrowserUrl('https://example.com')).toBe('https://example.com')
    expect(normalizeBrowserUrl('file:///c:/x')).toBe('file:///c:/x')
  })

  it('prefixes bare domains and localhost with https', () => {
    expect(normalizeBrowserUrl('deepseek.com')).toBe('https://deepseek.com')
    expect(normalizeBrowserUrl('docs.deepseek.com/a')).toBe('https://docs.deepseek.com/a')
    expect(normalizeBrowserUrl('localhost:3000')).toBe('https://localhost:3000')
  })
})

describe('WorkbenchBrowserPanel', () => {
  it('renders the address bar and navigates on submit', () => {
    const onNavigate = vi.fn()
    render(<WorkbenchBrowserPanel url="https://example.com" onNavigate={onNavigate} t={key => en[key as keyof typeof en]} />)
    expect(screen.getByLabelText(en['browser.addressAria'])).toBeTruthy()
    const input = screen.getByLabelText(en['browser.addressAria'])
    fireEvent.change(input, { target: { value: 'deepseek.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith('https://deepseek.com')
    expect(screen.getByTitle(en['browser.title'])).toBeTruthy()
  })
})
