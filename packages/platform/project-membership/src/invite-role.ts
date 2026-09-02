/**
 * Invitation grant policy for Project Membership. Owners may invite as
 * `admin` or `member`; admins may invite as `member` only; members invite
 * nobody. The owner role is never granted at accept time.
 * @module @deepseek-ai/dsh-project-membership/invite-role
 */

import type { GrantableInviteRole, ProjectRole } from './types.ts'

export type { GrantableInviteRole }

/**
 * Roles the actor may grant when issuing an invitation.
 * @param actorRole - the actor's current membership role.
 * @returns grantable roles in stable owner-then-member order; empty when the actor cannot invite.
 */
export function grantableInviteRoles(actorRole: ProjectRole): readonly GrantableInviteRole[] {
  switch (actorRole) {
    case 'owner': return ['admin', 'member']
    case 'admin': return ['member']
    case 'member': return []
    /* v8 ignore next 2 -- ProjectRole is closed and every member is handled above. */
    default: return actorRole satisfies never
  }
}

/**
 * Whether `grantedRole` is one of the roles `actorRole` may put on an invitation.
 * @param actorRole - the actor's current membership role.
 * @param grantedRole - role the invitation would confer at accept time.
 * @returns true only for an invite the actor is allowed to issue.
 */
export function canGrantInviteRole(actorRole: ProjectRole, grantedRole: ProjectRole): grantedRole is GrantableInviteRole {
  return grantableInviteRoles(actorRole).some(role => role === grantedRole)
}
