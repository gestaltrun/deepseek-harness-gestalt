/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-better-sidebar`.
 * @module @deepseek-ai/dsh-client-better-sidebar/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-better-sidebar'

/** Cordis companion plugin name. */
export const name = 'client-better-sidebar-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the snapshot host mounts HTTP and PTY routes under
 * the existing webServer trust fence, and the client store is a plain
 * snapshot registry owned by the upstream plugin. Those relationships are
 * observed through the host routes and the workbench adapter specs.
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
