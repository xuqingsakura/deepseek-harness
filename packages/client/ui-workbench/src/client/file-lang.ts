/** File-extension → language metadata shared by the viewer highlight hint and
 * the tab-bar file badge. */
/**
 * Lowercased file-extension to CodeBlock language hint (highlight.ts alias
 * ids) for the read-only viewer.
 */
export const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json',
  py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
  cs: 'cs', kt: 'kotlin', swift: 'swift', php: 'php',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', xml: 'xml', lua: 'lua',
}

/** Lowercased file-extension to tab-badge metadata (label + accent color). */
const BADGE_BY_EXTENSION: Readonly<Record<string, { label: string; color: string }>> = {
  ts: { label: 'TS', color: '#3178c6' },
  tsx: { label: 'TSX', color: '#3178c6' },
  mts: { label: 'TS', color: '#3178c6' },
  cts: { label: 'TS', color: '#3178c6' },
  js: { label: 'JS', color: '#f1e05a' },
  jsx: { label: 'JSX', color: '#f1e05a' },
  mjs: { label: 'JS', color: '#f1e05a' },
  cjs: { label: 'JS', color: '#f1e05a' },
  json: { label: '{}', color: '#cbcb41' },
  jsonc: { label: '{}', color: '#cbcb41' },
  md: { label: 'MD', color: '#519aba' },
  markdown: { label: 'MD', color: '#519aba' },
  mdx: { label: 'MDX', color: '#519aba' },
  py: { label: 'PY', color: '#3572a5' },
  rb: { label: 'RB', color: '#701516' },
  go: { label: 'GO', color: '#00add8' },
  rs: { label: 'RS', color: '#dea584' },
  java: { label: 'JAVA', color: '#b07219' },
  c: { label: 'C', color: '#555555' },
  h: { label: 'H', color: '#555555' },
  cc: { label: 'C++', color: '#f34b7d' },
  cpp: { label: 'C++', color: '#f34b7d' },
  hpp: { label: 'C++', color: '#f34b7d' },
  cxx: { label: 'C++', color: '#f34b7d' },
  cs: { label: 'C#', color: '#178600' },
  kt: { label: 'KT', color: '#a97bff' },
  swift: { label: 'SWIFT', color: '#f05138' },
  php: { label: 'PHP', color: '#4f5d95' },
  sh: { label: 'SH', color: '#89e051' },
  bash: { label: 'SH', color: '#89e051' },
  zsh: { label: 'SH', color: '#89e051' },
  yaml: { label: 'YML', color: '#cb171e' },
  yml: { label: 'YML', color: '#cb171e' },
  toml: { label: 'TOML', color: '#9c4221' },
  ini: { label: 'INI', color: '#d1dbe0' },
  html: { label: 'HTML', color: '#e34c26' },
  htm: { label: 'HTML', color: '#e34c26' },
  css: { label: 'CSS', color: '#563d7c' },
  scss: { label: 'SCSS', color: '#c6538c' },
  less: { label: 'LESS', color: '#1d365d' },
  sql: { label: 'SQL', color: '#e38c00' },
  xml: { label: 'XML', color: '#0060ac' },
  lua: { label: 'LUA', color: '#000080' },
}

/** Derive the basename from a path (forward- or backslash separated). */
function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** The file extension of a path, lowercased and without the dot ('' when none). */
function extensionOf(path: string): string {
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * Derive a CodeBlock language hint from a file path's extension; unknown or
 * dotfile extensions yield undefined (plain monospace, still copyable).
 * @param path - the file path relative to the session cwd.
 * @returns the language hint, or undefined when the extension maps to none.
 */
export function langFromPath(path: string): string | undefined {
  const ext = extensionOf(path)
  return ext === '' ? undefined : Object.hasOwn(LANG_BY_EXTENSION, ext) ? LANG_BY_EXTENSION[ext] : undefined
}

/**
 * Tab-badge metadata for a file path. Unknown or dotfile extensions fall back
 * to a neutral document glyph so every tab still shows a stable badge.
 * @param path - the file path relative to the session cwd.
 * @returns the badge label and accent color.
 */
export function fileBadge(path: string): { label: string; color: string } {
  const ext = extensionOf(path)
  return ext !== '' && Object.hasOwn(BADGE_BY_EXTENSION, ext)
    ? BADGE_BY_EXTENSION[ext] as { label: string; color: string }
    : { label: 'DOC', color: '#8a9199' }
}
