/**
 * Phone tab plugin, browser half: registers the always-reachable 「手机」
 * tab through the `ctx.betterSidebar` service and owns the deployment's
 * enable gate. With `enabled: false` (the default) the tab still mounts and
 * its body explains the gate — no device discovery, no mobilecli spawn, no
 * stream routing exists in this package.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PhoneTabIcon } from './phone-icon.tsx'
import { PhoneTab } from './PhoneTab.tsx'
import { installPhoneTab, NULL_PHONE_BADGE_SOURCE, type PhoneTabView } from './registry.ts'

/** Services required before activation: the Side card registry publisher. */
export const inject = ['betterSidebar'] as const

/**
 * Enable gate of the phone tab. The default stays `false`: a deployment must
 * opt in before any device discovery may run (contract placeholder until the
 * mobilecli ticket wires real detection).
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
 * @param ctx - client context carrying the betterSidebar service.
 * @param config - validated {@link Config} (schema defaults applied).
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees the field after validation.
  const enabled = config.enabled === true
  const view: PhoneTabView = {
    icon: size => <PhoneTabIcon size={size} />,
    component: () => <PhoneTab enabled={enabled} source={NULL_PHONE_BADGE_SOURCE} />,
  }
  installPhoneTab(ctx, { source: NULL_PHONE_BADGE_SOURCE, view })
}
