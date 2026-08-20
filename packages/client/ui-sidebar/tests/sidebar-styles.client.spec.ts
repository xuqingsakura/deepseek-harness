/** Sidebar shell style contracts shared with its slot-owned controls. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SidebarRoot.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one exact selector, keyed by property.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when absent.
 */
function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

describe('SidebarRoot.module.css', () => {
  it('shares the wide shell padding variable and cancels it in the region', () => {
    const root = declarations('.root')
    expect(root?.get('--dsh-sidebar-inline-padding')).toBe('12px')
    expect(declarations('.panel')?.get('padding')).toBe('6px var(--dsh-sidebar-inline-padding)')
    expect(declarations('.regionArea')?.get('margin-left')).toBe('-4px')
    expect(declarations('.regionArea')?.get('padding-left')).toBe('4px')
    expect(declarations('.regionArea')?.get('margin-right')).toBe(
      'calc(-1 * var(--dsh-sidebar-inline-padding))',
    )
  })

  it('keeps the activity rail as a fixed 56px column with a hairline divider', () => {
    const bar = declarations('.activityBar')
    expect(bar?.get('width')).toBe('56px')
    expect(bar?.get('border-right')).toBe('1px solid var(--dsw-alias-border-l1)')
    expect(declarations('.activityIcon')?.get('width')).toBe('36px')
    expect(declarations('.activityIcon')?.get('height')).toBe('36px')
    expect(declarations('.activityIconActive')?.get('color')).toBe('var(--dsw-alias-label-primary)')
  })

  it('fades the panel on collapse while the rail persists', () => {
    const fading = declarations('.fading .panel')
    expect(fading?.get('opacity')).toBe('0')
    expect(fading?.get('transition')).toContain('150ms')
    // The panel is a row sibling of the rail (flex row, not column).
    expect(declarations('.root')?.get('display')).toBe('flex')
    expect(declarations('.root')?.get('flex-direction')).toBe('row')
  })

})
