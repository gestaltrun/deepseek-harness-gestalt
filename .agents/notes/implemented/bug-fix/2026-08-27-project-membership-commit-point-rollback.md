# Agent Note: Project membership publishes state only at its durable commit point

Status: implemented

English | [中文](2026-08-27-project-membership-commit-point-rollback.zh.md)

## Problem

The file-backed Project Membership provider applied every mutation batch to its in-memory authoritative tables before awaiting the whole-document write. A rejected durable write therefore left the applied batch resident: reads answered from rows the durable document never accepted, duplicate gates rejected retries against ghost rows, and the next successful mutation serialized the residue into the document — publishing state an earlier commit had refused. One durability outage silently became durable data.

## Decision

Every mutation commits at its durable point. The operation applies its batch, then `commit` awaits the complete-document `writeFileAtomic`; a failure runs the batch's exact inverse before the rejection returns — added rows are deleted, prior roles and tags are restored, settled invitations are un-settled back to their pending spelling. The single write chain makes the applied batch invisible until that point, so the inverse restores the exact pre-call state, and reads, retries, and later documents behave as if the call never ran. Each batch is stated once, as code plus its inverse closure; no parallel document-delta representation exists to drift. The placement of this authority behind the [Project Membership service seam](../feature/2026-08-27-project-membership-core.md) is unchanged.

## Verification

The executor suite injects rename failures by replacing the environment document with a directory, then requires, for project creation, invitations, and the accept/decline/retract/role/tags/remove families: the caller receives the rejection; reads and retries are indistinguishable from a call that never happened (a refused invite re-invites instead of reporting `DUPLICATE_INVITEE`, a refused creation frees its name for reuse); and one later successful commit serializes exactly the settled rows with no ghost lines.

## Alternatives considered

**Build the post-change document first and mutate memory only after the write succeeds.** Rejected: every operation would state its batch twice — once as document deltas, once as authoritative-table updates — doubling the drift surface behind the defect.

**Restore from a full state snapshot on failure.** Rejected: a deep copy of every project, membership, and invitation per mutation to guard one batch, when the inverse closure is exact and free.

## Consequences

A durability outage surfaces as the failed call's rejection alone; at every commit boundary memory and disk hold identical rows. The durable `rosterVersion` keeps carrying the version as of commit time, because publication still follows durability — the tested one-commit lag is unchanged. A failed write leaves nothing for the write chain's next commit to serialize.
