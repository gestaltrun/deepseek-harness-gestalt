# Agent Note: Derive Workspace Settings administration from the current membership

Status: implemented

English | [中文](2026-09-01-project-members-role-aware-workspace-settings.zh.md)

## Problem

Every project member can read the roster, but issued invitations and roster mutations require an admin or owner. Workspace Settings cannot distinguish the current Account from other roster rows when its recovered Project projection omits the Account id, so an ordinary member triggers an issuer-only read and receives `ROLE_REQUIRED` while seeing controls that cannot succeed.

## Decision

The Workspace Project projection preserves the authenticated `receivingAccountId` returned by Project creation or remote recovery. After reading the authoritative roster, Workspace Settings locates that Account's membership and derives whether the actor is an admin or owner. Admins and owners receive invitation reads and roster mutation controls; ordinary members receive the same presence-decorated roster as read-only role and function-tag values. Unknown or absent actor memberships fail closed as read-only and never start an issuer-only request.

The Project Membership service remains the authority for every read and mutation. The client projection removes impossible affordances and expected authorization failures without weakening service-side role checks.

Presence text remains available to assistive technology through a module-scoped visually hidden class. The label must not consume roster-row layout space or overlap the member identity.

## Alternatives considered

- **Catch and hide `ROLE_REQUIRED` from the issued-invitation request** — rejected because the unauthorized request still runs and mutation controls still advertise operations that cannot succeed.
- **Add the collaboration role to Platform Account access state** — rejected because roles belong to one Project membership and may differ across Projects; the roster already owns the required fact.
- **Allow ordinary members to read issued invitations** — rejected because invitation administration is intentionally limited to admins and owners and may reveal unrelated invitees.

## Consequences

Workspace Settings is useful to every active member without presenting authorization errors. An Account's administration controls update from the same roster read that renders members, so a role change takes effect on the next authoritative reload. Focused UI coverage verifies that an ordinary member sees both roster identities with a non-layout presence label while issuing no admin read and rendering no invitation, role, tag, or removal controls.
