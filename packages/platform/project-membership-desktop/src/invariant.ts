/** Package-owned invariant companion for the Desktop Project Membership bridge provider. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-project-membership-desktop'

/** Cordis companion plugin name. */
export const name = 'project-membership-desktop-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: roster-presentation identity is enforced by
 * DesktopProjectMembershipService.present() against the Map this package owns.
 */
const install: InvariantInstaller = () => {}

/** Register the provider package ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
