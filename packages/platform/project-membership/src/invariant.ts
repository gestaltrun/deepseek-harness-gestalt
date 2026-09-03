/** Package-owned invariant companion for the Project Membership Service Definition. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-project-membership'

/** Cordis companion plugin name. */
export const name = 'project-membership-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the definition owns no state or event stream; the provider package checks its own authority relations. */
const install: InvariantInstaller = () => {}

/** Register definition-package ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
