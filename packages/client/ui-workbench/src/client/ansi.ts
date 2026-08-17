/** Minimal ANSI parser for terminal output rendering: splits text into plain
 * chunks and styled spans (foreground, background, bold, inverse). The shell
 * pipe carries raw escape sequences; parsing here keeps the stored output
 * plain while the view renders it with the theme's terminal palette. SGR
 * codes set the running style; every other CSI sequence is dropped. */

/** One rendered segment: either plain text or a styled run. */
export type AnsiSegment =
  | { text: string; style?: undefined }
  | { text: string; style: AnsiStyle }

/** Resolved style for one styled run. */
export interface AnsiStyle {
  fg?: string
  bg?: string
  bold?: boolean
  inverse?: boolean
}

/** The 8 base ANSI colors, mapped to the app's terminal palette. */
const COLORS: readonly [string, string, string, string, string, string, string, string] = [
  '#282c34', '#e06c75', '#98c379', '#e5c07b',
  '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
]
/** Bright variants (codes 90-97 / 100-107). */
const BRIGHT: readonly [string, string, string, string, string, string, string, string] = [
  '#5c6370', '#e06c75', '#98c379', '#e5c07b',
  '#61afef', '#c678dd', '#56b6c2', '#ffffff',
]

/** Any CSI sequence: ESC [ params final-byte. */
const CSI_RE = /\x1b\[([0-9;:?]*)([@-~])/g

/**
 * Parse text containing escape sequences into renderable segments.
 * @param text - raw terminal output.
 * @returns an ordered list of plain and styled segments.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  if (!text.includes('\x1b')) return [{ text }]
  const segments: AnsiSegment[] = []
  let lastIndex = 0
  let fg: string | undefined
  let bg: string | undefined
  let bold = false
  let inverse = false
  const pushText = (from: number, to: number): void => {
    if (to <= from) return
    const body = text.slice(from, to).replace(/\x1b/g, '')
    if (body === '') return
    const style = fg !== undefined || bg !== undefined || bold || inverse
      ? {
        ...(fg !== undefined ? { fg } : {}),
        ...(bg !== undefined ? { bg } : {}),
        ...(bold ? { bold: true } : {}),
        ...(inverse ? { inverse: true } : {}),
      }
      : undefined
    if (style === undefined) {
      const last = segments[segments.length - 1]
      if (last !== undefined && last.style === undefined) {
        last.text += body
        return
      }
      segments.push({ text: body })
    } else {
      segments.push({ text: body, style })
    }
  }
  for (const match of text.matchAll(CSI_RE)) {
    const start = match.index ?? 0
    pushText(lastIndex, start)
    lastIndex = start + match[0].length
    if (match[2] !== 'm') continue
    const raw = match[1] ?? ''
    const params = raw === '' ? [0] : raw.split(';').map(Number)
    for (const param of params) {
      if (param === 0) { fg = undefined; bg = undefined; bold = false; inverse = false }
      else if (param === 1) bold = true
      else if (param === 7) inverse = true
      else if (param >= 30 && param <= 37) fg = COLORS[param - 30] as string
      else if (param >= 40 && param <= 47) bg = COLORS[param - 40] as string
      else if (param >= 90 && param <= 97) fg = BRIGHT[param - 90] as string
      else if (param >= 100 && param <= 107) bg = BRIGHT[param - 100] as string
    }
  }
  pushText(lastIndex, text.length)
  return segments
}
