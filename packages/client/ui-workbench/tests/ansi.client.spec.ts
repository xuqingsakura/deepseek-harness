// @vitest-environment node
/**
 * parseAnsi contract: plain text passes through untouched, SGR codes map to
 * the theme palette, a reset clears the active style, and the trailing run
 * after the last escape is kept. Invalid or unknown codes are ignored.
 */
import { describe, expect, it } from 'vitest'
import { parseAnsi } from '@deepseek-ai/dsh-client-ui-workbench/src/client/ansi.ts'

describe('parseAnsi', () => {
  it('passes plain text through as one segment', () => {
    expect(parseAnsi('hello world')).toEqual([{ text: 'hello world' }])
  })

  it('maps a foreground color run', () => {
    const segments = parseAnsi('\x1b[31mred\x1b[0m plain')
    expect(segments).toEqual([
      { text: 'red', style: { fg: '#e06c75' } },
      { text: ' plain' },
    ])
  })

  it('maps bright colors and backgrounds', () => {
    const segments = parseAnsi('\x1b[91;44mbright on blue\x1b[0m')
    expect(segments).toEqual([
      { text: 'bright on blue', style: { fg: '#e06c75', bg: '#61afef' } },
    ])
  })

  it('tracks bold and inverse flags', () => {
    const segments = parseAnsi('\x1b[1;7mstrong\x1b[0m')
    expect(segments).toEqual([
      { text: 'strong', style: { bold: true, inverse: true } },
    ])
  })

  it('keeps the trailing run after the last escape', () => {
    const segments = parseAnsi('\x1b[32mok\x1b[0m done')
    expect(segments).toEqual([
      { text: 'ok', style: { fg: '#98c379' } },
      { text: ' done' },
    ])
  })

  it('drops unknown control sequences', () => {
    const segments = parseAnsi('a\x1b[Kb')
    expect(segments).toEqual([{ text: 'ab' }])
  })
})
