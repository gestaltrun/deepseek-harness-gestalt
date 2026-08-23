/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-workbench`.
 * @module @deepseek-ai/dsh-client-ui-workbench/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-workbench'

/** Cordis companion plugin name. */
export const name = 'client-ui-workbench-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this adapter writes one settings patch and pairs
 * official pages with snapshot tabs. The snapshot host remains the owner of
 * sidebar state; Browser Workspace remains the owner of page identities.
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
