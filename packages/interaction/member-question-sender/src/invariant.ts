/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-member-question-sender`.
 * @module @deepseek-ai/dsh-member-question-sender/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-member-question-sender'

/** Cordis companion plugin name. */
export const name = 'member-question-sender-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the sender owns no durable stream; codec validity and
 * delivery acceptance are owned by the T4 codec and the injected adapter.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
