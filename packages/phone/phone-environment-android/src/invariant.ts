/** Runtime invariant for the Android environment Provider package. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-phone-environment-android'

export const name = 'phone-environment-android-invariant'
export const inject = ['invariants'] as const

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  if (ctx.phoneEnvironment.snapshot().platforms.android.kind === 'deferred') {
    fail('Android environment Provider did not replace the deferred platform state')
  }
}, { inject: ['phoneEnvironment'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
