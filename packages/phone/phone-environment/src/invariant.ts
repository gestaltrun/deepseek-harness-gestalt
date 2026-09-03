/**
 * Package invariant companion for the phone environment snapshot revision relation.
 * @module @deepseek-ai/dsh-phone-environment/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-phone-environment'

/** Cordis companion plugin name. */
export const name = 'phone-environment-invariant'
/** Registry required before the companion can register. */
export const inject = ['invariants']

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  let previous = ctx.phoneEnvironment.snapshot()
  ctx.effect(() => ctx.phoneEnvironment.onChanged((next) => {
    if (next.revision !== previous.revision + 1) {
      fail(`phone environment snapshot revision jumped from ${String(previous.revision)} to ${String(next.revision)}`)
    }
    if (next.enabled === previous.enabled && next.runtime === previous.runtime && next.platforms === previous.platforms) {
      fail('phone environment published a snapshot with no observable change')
    }
    previous = next
  }), 'phone environment invariant observation')
}, { inject: ['phoneEnvironment'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
