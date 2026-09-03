/**
 * Package-owned invariant companion for the Project Membership provider: the
 * published roster-invalidation stream must agree with the version protocol
 * the durable store commits — every mutation publishes exactly one version
 * step, and no project's projection ever moves backwards, removals included.
 * @module @deepseek-ai/dsh-project-membership-core/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ProjectId, RosterInvalidation } from '@deepseek-ai/dsh-project-membership'

const PACKAGE_NAME = '@deepseek-ai/dsh-project-membership-core'

/** Cordis invariant-companion plugin name. */
export const name = 'project-membership-core-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the roster-version stream agreement check into its registration fiber.
 *
 * The provider serializes every committed mutation and emits its record after
 * durability, so the `project-membership/roster-invalidated` stream is each
 * project's authoritative publication history. Three relations hold on that
 * stream:
 *
 * 1. a commit advances the project's projection by exactly one version;
 * 2. versions observed per project strictly increase over stream order — in
 *    particular every `removed` commit publishes a strictly higher version
 *    than anything seen before it for that project;
 * 3. only a founding `joined` commit may start from version zero.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const lastSeen = new Map<ProjectId, number>()
  ctx.on('project-membership/roster-invalidated', (change: RosterInvalidation) => {
    if (change.rosterVersionAfter !== change.rosterVersionBefore + 1) {
      return fail(
        `${change.reason} commit on ${change.projectId} published ${change.rosterVersionAfter} `
        + `but ${change.rosterVersionBefore} admits only ${change.rosterVersionBefore + 1}`,
      )
    }
    if (change.rosterVersionBefore === 0 && change.reason !== 'joined') {
      return fail(`${change.reason} commit on ${change.projectId} claims a nonexistent pre-state`)
    }
    const previous = lastSeen.get(change.projectId)
    if (previous !== undefined && change.rosterVersionAfter <= previous) {
      return fail(
        `roster version for ${change.projectId} moved from ${previous} to ${change.rosterVersionAfter}; `
        + 'committed mutations must strictly increase the projection',
      )
    }
    lastSeen.set(change.projectId, change.rosterVersionAfter)
  }, { global: true })
}

/**
 * Register the provider-package invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
