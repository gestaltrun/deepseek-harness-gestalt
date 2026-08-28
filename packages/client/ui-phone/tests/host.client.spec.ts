/**
 * Host half of the phone plugin: the durable `ui-phone` settings namespace
 * is the join key the Plugins tab uses to dispatch this package's card.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply } from '../src/index.ts'
import {
  DEFAULT_PHONE_SETTINGS, PHONE_SETTINGS_NAMESPACE, PhoneSettingsSchema,
} from '../src/phone-settings.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('ui-phone host settings', () => {
  it('registers the same namespace the browser card keys on', async () => {
    expect(PHONE_SETTINGS_NAMESPACE).toBe('ui-phone')
    expect(PhoneSettingsSchema({} as typeof DEFAULT_PHONE_SETTINGS)).toEqual(DEFAULT_PHONE_SETTINGS)

    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const ns = settingsNamespace(PHONE_SETTINGS_NAMESPACE)
    expect(ctx.settings.get(ns)).toEqual(DEFAULT_PHONE_SETTINGS)
    await ctx.settings.update(ns, { enabled: true })
    expect(ctx.settings.get(ns)).toEqual({ enabled: true })
    await expect(ctx.settings.update(ns, { enabled: 'yes' })).rejects.toThrow()
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('leaves the Host running when no settings provider is composed', async () => {
    const ctx = new Context()
    await expect(ctx.plugin({ apply }).await()).resolves.toBeDefined()
  })
})
