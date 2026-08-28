/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-request-trust`.
 * @module @deepseek-ai/dsh-request-trust/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-request-trust'

/** Cordis companion plugin name. */
export const name = 'request-trust-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this pure judgment module owns no event stream or mutable runtime data; its
 * trust rules are enforced by unit tests at the shared module and both consuming routes.
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
