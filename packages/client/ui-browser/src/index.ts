/**
 * Browser Dock plugin, node half. Registers the durable Browser Profile
 * section; the browser half ships via exports["./client"].
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { BROWSER_SETTINGS_NAMESPACE, BrowserSettingsSchema } from './browser-settings.ts'

export {
  BROWSER_PROFILE_KINDS,
  BROWSER_PROFILE_NAME,
  BROWSER_SETTINGS_NAMESPACE,
  DEFAULT_BROWSER_PROFILE_KIND,
  DEFAULT_BROWSER_SETTINGS,
  browserCreateRequestFromSettings,
  isBrowserProfileName,
  type BrowserProfileKindSetting,
  type BrowserSettings,
} from './browser-settings.ts'

const BROWSER_NAMESPACE = settingsNamespace(BROWSER_SETTINGS_NAMESPACE)

/**
 * Register the durable Browser Profile section when settings is composed.
 * @param ctx - Host context that may acquire settings.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(BROWSER_NAMESPACE, BrowserSettingsSchema)
  })
}
