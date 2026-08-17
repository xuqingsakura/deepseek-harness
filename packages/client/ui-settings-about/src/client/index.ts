/**
 * About & Updates settings section, browser half. Registers the desktop-only
 * About nav entry when the Electron bridge (`window.dshDesktop`) is present;
 * the browser build never mounts it. Export discipline:
 * packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AboutSection } from './AboutSection.tsx'
import type { AboutSectionInjected } from './AboutSection.tsx'
import { en, zh, type AboutKey } from './locales.ts'

export type { AboutSectionInjected, AboutSectionProps } from './AboutSection.tsx'
export type { AboutKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The About & Updates page copy. */
    'settings.about': AboutKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.about'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on the slot through `slots.inject()`.
 */
export const inject = ['slots', 'locale']

/**
 * Register the About & Updates section once the `settings.section`
 * declaration is on the ledger. The section is desktop-only: the update
 * surface lives behind the Electron bridge, so the browser build never
 * mounts it.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-about: copy dictionaries')
  if ((globalThis as { dshDesktop?: unknown }).dshDesktop === undefined) return
  const t = ctx.locale.bind(NS) as AboutSectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'about',
    order: 90,
    label: () => t('nav'),
    locale: NS,
    inject: (): AboutSectionInjected => ({ t }),
  }, AboutSection))
}
