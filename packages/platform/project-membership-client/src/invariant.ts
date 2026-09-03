/** Package-owned invariant companion for the Project Membership client. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-project-membership-client'

/** Cordis companion plugin name. */
export const name = 'project-membership-client-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the transport owns no state beyond its origin and fetch adapter. */
const install: InvariantInstaller = () => {}

/** Register client-library package ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
