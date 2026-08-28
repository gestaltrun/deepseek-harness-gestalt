/**
 * Phone plugin, node half. Registers the durable `ui-phone` settings
 * namespace (the join key of the Plugins-tab card) when a settings
 * provider is composed. The browser half ships via exports["./client"].
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { PHONE_SETTINGS_NAMESPACE, PhoneSettingsSchema } from './phone-settings.ts'

export {
  DEFAULT_PHONE_SETTINGS, PHONE_SETTINGS_NAMESPACE, PhoneSettingsSchema,
} from './phone-settings.ts'
export type { PhoneSettings } from './phone-settings.ts'

const PHONE_NAMESPACE = settingsNamespace(PHONE_SETTINGS_NAMESPACE)

/**
 * Register the durable phone section when settings is composed.
 * @param ctx - Host context that may acquire settings.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(PHONE_NAMESPACE, PhoneSettingsSchema)
  })
}
