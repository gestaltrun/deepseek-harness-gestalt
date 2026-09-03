/** Runtime invariant for the iOS environment Provider package. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-phone-environment-ios'

export const name = 'phone-environment-ios-invariant'
export const inject = ['invariants'] as const

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  if (ctx.phoneEnvironment.snapshot().platforms.ios.kind === 'deferred') {
    fail('iOS environment Provider did not replace the deferred platform state')
  }
}, { inject: ['phoneEnvironment'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
