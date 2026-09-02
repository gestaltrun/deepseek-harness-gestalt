# Agent Note: Invitation wizard grants a chosen Project role

Status: implemented

English | [中文](2026-09-02-invitation-granted-role.zh.md)

## Problem

T1 membership operations already distinguished owner, admin, and member, but T6 invitations always joined as `member`. An owner who needed a colleague to invite others therefore had to promote that person after accept, and an admin who forged a higher role on the wire had no executor denial to stop it. The pending invitation card also hid the role the invitee would receive, so closing the link step could not prove that the still-pending invitation kept that choice.

## Decision

The invitation itself is the grant: `InviteInput.grantedRole` is required, stored on the invitation row, shown on pending and issued presentations, and copied onto the membership created by atomic accept-with-workspace-link. Owners may grant `admin` or `member`; admins may grant `member` only; members invite nobody. The owner role is never granted at join — promotion remains a later `changeRole` on an existing membership. The membership operation owns that gate; HTTP, Desktop IPC, and the settings picker only present or parse the requested role. Closing the link step still decides nothing, so the pending invitation keeps the same `grantedRole`. Durable documents record the field under `formatVersion 1`; a missing or `owner` `grantedRole` is corruption, not a default.

The grantable-role helper lives at `@deepseek-ai/dsh-project-membership/invite-role` so the settings picker and the executor share one policy. The picker offers only the roles the current actor's roster row may grant and never invents a hidden higher option.

## Alternatives considered

**Always join as `member`, then promote.** Rejected because the invitee would appear as a member between accept and promotion, and an interrupted promote would leave the wrong role durable. The ticket requires the chosen role to become the membership role at accept.

**Let the invitee pick the role at the link step.** Rejected because the grant belongs to the inviter. An invitee choosing `admin` would bypass the inviter's authority.

**Default omitted `grantedRole` to `member`.** Rejected because a missing field on a new document is indistinguishable from a forgotten picker value. The wire and durable document require the field, and the executor refuses any role the actor cannot grant.

## Consequences

Forged `owner` or admin-issued `admin` invitations fail as `ROLE_REQUIRED` inside `invite` and never persist. Invitees see the granted role before they choose a workspace, and closing that step leaves the invitation pending with the same role. Existing `formatVersion 0` documents fail to load rather than silently joining as `member`; this capability has no production corpus yet, so the bump is the loud failure the store already uses for structural change.
