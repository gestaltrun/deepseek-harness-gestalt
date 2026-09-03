/**
 * Invitation grant policy: owners invite as admin or member, admins invite as
 * member only, and members invite nobody. The owner role is never grantable.
 */

import { describe, expect, it } from 'vitest'
import { canGrantInviteRole, grantableInviteRoles } from '../src/invite-role.ts'

describe('invitation grant policy', () => {
  it('lists the roles each actor may put on an invitation', () => {
    expect(grantableInviteRoles('owner')).toEqual(['admin', 'member'])
    expect(grantableInviteRoles('admin')).toEqual(['member'])
    expect(grantableInviteRoles('member')).toEqual([])
  })

  it('refuses owner grants and any role the actor cannot issue', () => {
    expect(canGrantInviteRole('owner', 'admin')).toBe(true)
    expect(canGrantInviteRole('owner', 'member')).toBe(true)
    expect(canGrantInviteRole('owner', 'owner')).toBe(false)
    expect(canGrantInviteRole('admin', 'member')).toBe(true)
    expect(canGrantInviteRole('admin', 'admin')).toBe(false)
    expect(canGrantInviteRole('admin', 'owner')).toBe(false)
    expect(canGrantInviteRole('member', 'member')).toBe(false)
  })
})
