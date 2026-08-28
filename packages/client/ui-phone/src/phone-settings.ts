/**
 * Durable phone-plugin settings stored in the Host user-settings document.
 * The namespace is the join key with the Plugins tab's `settings.plugin.item`
 * card: Host `settings.register` and the browser card both spell this value.
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the phone plugin. */
export const PHONE_SETTINGS_NAMESPACE = 'ui-phone'

/** Durable phone section shared by the Host schema and the browser scope. */
export interface PhoneSettings {
  /**
   * Whether this deployment enables phone device detection and streaming.
   * False keeps the Host from spawning mobilecli or registering device tools.
   */
  enabled: boolean
}

/** Default section matching today's composition `Config.enabled` default. */
export const DEFAULT_PHONE_SETTINGS: PhoneSettings = {
  enabled: false,
}

/** Durable schema; also the wire envelope the browser scope validates against. */
export const PhoneSettingsSchema: z<PhoneSettings> = z.object({
  enabled: z.boolean().default(false),
})
