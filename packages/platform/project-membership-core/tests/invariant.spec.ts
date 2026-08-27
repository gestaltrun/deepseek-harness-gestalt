/**
 * Focused negative coverage for the package-owned roster-version invariant
 * companion: the real {@link InvariantRegistry} runner installs the companion,
 * and an injected violating `project-membership/roster-invalidated` stream
 * fails loud with an {@link InvariantError} attributed to this package. This
 * suite owns its invariant topology explicitly (see scripts/test-invariants.ts),
 * so every case boots one fresh registry.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import type { MembershipId, ProjectId, RosterInvalidation } from '@deepseek-ai/dsh-project-membership'
import { apply } from '../src/invariant.ts'

const projectId = 'invariant-probe-project' as ProjectId
const membershipId = 'invariant-probe-membership' as MembershipId
const accountId = 'invariant-probe-account' as PlatformAccountId

/** Publishes a version step other than the required single increment. */
const invalidStep: RosterInvalidation = {
  reason: 'joined',
  projectId,
  membershipId,
  accountId,
  rosterVersionBefore: 2,
  rosterVersionAfter: 5,
}

/** A non-founding commit that claims version zero as its pre-state. */
const zeroPreState: RosterInvalidation = {
  reason: 'removed',
  projectId,
  membershipId,
  accountId,
  rosterVersionBefore: 0,
  rosterVersionAfter: 1,
}

/** A valid founding commit that starts the projection at version one. */
const foundingCommit: RosterInvalidation = {
  reason: 'joined',
  projectId,
  membershipId,
  accountId,
  rosterVersionBefore: 0,
  rosterVersionAfter: 1,
}

/** A valid later commit advancing the projection strictly beyond its predecessor. */
const laterCommit: RosterInvalidation = {
  reason: 'removed',
  projectId,
  membershipId,
  accountId,
  rosterVersionBefore: 2,
  rosterVersionAfter: 3,
}

/** Boot one root whose real invariant registry has the package companion installed. */
async function bootedRoot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await apply(ctx)
  return ctx
}

describe('roster-version invariant companion under the real runner', () => {
  it('fails when a commit publishes a version step other than one', async () => {
    const ctx = await bootedRoot()
    expect(() => {
      ctx.emit('project-membership/roster-invalidated', invalidStep)
    }).toThrow(InvariantError)
  })

  it('fails when a non-founding commit claims version zero as its pre-state', async () => {
    const ctx = await bootedRoot()
    expect(() => {
      ctx.emit('project-membership/roster-invalidated', zeroPreState)
    }).toThrow(InvariantError)
  })

  it('fails when a project projection stops strictly increasing', async () => {
    const ctx = await bootedRoot()
    expect(() => {
      ctx.emit('project-membership/roster-invalidated', foundingCommit)
    }).not.toThrow()
    expect(() => {
      ctx.emit('project-membership/roster-invalidated', laterCommit)
    }).not.toThrow()
    expect(() => {
      ctx.emit('project-membership/roster-invalidated', laterCommit)
    }).toThrow(InvariantError)
  })
})
