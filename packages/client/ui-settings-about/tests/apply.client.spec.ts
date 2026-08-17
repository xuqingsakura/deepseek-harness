/** About & Updates section registration: desktop-only nav entry + locale label. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-about/client'
import { AboutSection } from '../src/client/AboutSection.tsx'

// The section mounts only when the Electron bridge is present; the browser
// build never registers it.
usePinnedBrowserLanguages('zh-CN')

async function bench(withDesktop: boolean) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  if (withDesktop) {
    ;(globalThis as { dshDesktop?: unknown }).dshDesktop = {}
  } else {
    delete (globalThis as { dshDesktop?: unknown }).dshDesktop
  }
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register(
    {
      name: 'root',
      children: { 'settings.section': { kind: 'list', scope: 'root' } },
    } as never,
    () => null,
  )
}

describe('ui-settings-about apply', () => {
  afterEach(() => {
    delete (globalThis as { dshDesktop?: unknown }).dshDesktop
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('does not register the section in the browser build', async () => {
    const bench_ = await bench(false)
    declare(bench_.slots)
    await bench_.ctx.plugin({ inject: [...inject], apply }).await()
    expect(bench_.slots.entries('settings.section')).toHaveLength(0)
  })

  it('registers the about nav entry when the desktop bridge is present', async () => {
    const bench_ = await bench(true)
    declare(bench_.slots)
    await bench_.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = bench_.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(AboutSection)
    expect(entry.options).toMatchObject({ id: 'about', order: 90 })
    // The nav label is a locale-following thunk; owners resolve at read time.
    expect(resolveSlotLabel(entry.options.label)).toBe('关于与更新')
    const injected = (entry.inject as unknown as () => import('../src/client/AboutSection.tsx').AboutSectionInjected)()
    expect(injected.t('nav')).toBe('关于与更新')
    expect(injected.t('checkForUpdates')).toBe('检查更新')
  })
})
