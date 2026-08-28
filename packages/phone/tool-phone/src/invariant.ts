/** Package-owned invariant companion for the phone device Consumer. @module @deepseek-ai/dsh-tool-phone/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-phone'

/** Cordis companion plugin name. */
export const name = 'tool-phone-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: dsh-tools owns registration, eligibility, deferred discovery, execution, and disposal relationships. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Context owning the invariant registry.
 * @returns the exact registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
