/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-member-questions`.
 * @module @deepseek-ai/dsh-client-ui-member-questions/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-member-questions'

/** Cordis companion plugin name. */
export const name = 'client-ui-member-questions-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the composer-chain entry is an effect owned and
 * observed by the slot registry, and the banner is a pure function of the
 * carrier payload exercised through the public component contract.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
