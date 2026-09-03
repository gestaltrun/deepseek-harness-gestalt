/** Package-owned invariant companion for Project Membership HTTP routes. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-project-membership-http'

/** Cordis companion plugin name. */
export const name = 'project-membership-http-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the webserver rejects duplicate route registrations,
 * and this Consumer copies no membership state — role gates, roster relations,
 * and the roster-version stream are owned and checked by the membership
 * service and its provider package.
 */
const install: InvariantInstaller = () => {}

/** Register HTTP-consumer package ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
