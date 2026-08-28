/**
 * Phone plugin, browser half: registers the always-reachable 「手机」
 * tab through the `ctx.betterSidebar` service and the Plugins-tab card
 * keyed on the `ui-phone` settings namespace. With `enabled: false`
 * (the default) the tab still mounts and the card stays in the off chrome;
 * no device discovery, no mobilecli spawn, no stream routing exists here.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { PhoneTabIcon } from './phone-icon.tsx'
import { PhoneTab } from './PhoneTab.tsx'
import { PhoneSettingsItem } from './PhoneSettingsItem.tsx'
import { PhoneSettingsCardController } from './phone-settings-controller.ts'
import { MISSING_PHONE_ENVIRONMENT_SOURCE } from './phone-environment.ts'
import { installPhoneTab, NULL_PHONE_BADGE_SOURCE, type PhoneTabView } from './registry.ts'
import { PHONE_SETTINGS_NAMESPACE } from '../phone-settings.ts'
import type { PhoneSettings } from '../phone-settings.ts'

/** Services required before activation. */
export const inject = ['betterSidebar', 'slots', 'settingsScope'] as const

/**
 * Enable gate of the phone tab. The default stays `false`: a deployment must
 * opt in before any device discovery may run (contract placeholder until the
 * mobilecli ticket wires real detection). The Host `ui-phone` section is the
 * durable copy of this flag; composition Config remains the Loader default.
 */
export interface Config {
  /** Whether this deployment enables phone device detection and streaming. */
  readonly enabled?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
})

/**
 * Client plugin body.
 * @param ctx - client context carrying the betterSidebar and settings services.
 * @param config - validated {@link Config} (schema defaults applied).
 */
export function apply(ctx: ClientContext, config: Config): void {
  const compositionEnabled = config.enabled === true
  const scope = ctx.settingsScope.bind<PhoneSettings>({ namespace: PHONE_SETTINGS_NAMESPACE })
  const card = new PhoneSettingsCardController(
    scope,
    MISSING_PHONE_ENVIRONMENT_SOURCE,
    globalThis.navigator?.clipboard,
  )
  ctx.effect(() => () => { card.dispose() }, 'ui-phone: settings card')

  const tabEnabled = (): boolean => {
    const snapshot = scope.getSnapshot()
    if (snapshot.status === 'ready' && snapshot.value !== undefined) return snapshot.value.enabled === true
    return compositionEnabled
  }
  const view: PhoneTabView = {
    icon: size => <PhoneTabIcon size={size} />,
    component: () => <PhoneTab enabled={tabEnabled()} source={NULL_PHONE_BADGE_SOURCE} />,
  }
  installPhoneTab(ctx, { source: NULL_PHONE_BADGE_SOURCE, view })

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: PHONE_SETTINGS_NAMESPACE,
    inject: () => card.inject(),
  }, PhoneSettingsItem))
}
