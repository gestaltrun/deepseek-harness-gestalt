import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { MemberQuestionReceiverChange } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-member-question-receiver'

export const name = 'member-question-receiver-invariant'
export const inject = ['invariants']

const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  let previous = 0
  ctx.on('member-question-receiver/changed', (change: MemberQuestionReceiverChange) => {
    if (change.revision <= previous) {
      return fail(`receiver ledger revision moved from ${previous} to ${change.revision}`)
    }
    previous = change.revision
  }, { global: true })
}

/**
 * Register the receiver-ledger revision invariant.
 * @param ctx - context carrying the invariant registry.
 * @returns the registration disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
