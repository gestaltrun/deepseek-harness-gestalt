# Agent Note: Member Question references open through Better Sidebar Files

Status: implemented

English | [中文](2026-09-03-member-question-files-sidebar.zh.md)

## Problem

A routed Member Question can carry referenced documents. T6 opened those chips into a Member-Question-specific details-panel document seat. That preview never used the receiving Session's Files viewer, so markdown, sandboxed HTML, and unsupported types had a second in-product dock. Transferred bytes also had no receiver-owned Workspace path, so a same-named local file could be overwritten or opened by mistake.

## Decision

The Host Session materializer writes transferred document bytes under a receiver-owned hidden Workspace directory: `.dsh/member-questions/<questionId>/<basename>`. Colliding basenames inside one question receive a numeric suffix. The same-named Workspace file is never replaced. The receiver ledger stores only `{ path, reason, cachedPath }` metadata; document bodies stay outside the JSON document.

Clicking a material chip opens that cached path through `ctx.betterSidebar.openFile` with the receiving Session id. Markdown, sandboxed HTML, and unsupported types reuse the ordinary Files viewers. When the Files editor tab is unregistered, the chip falls through to `ctx.workspaces.openPath` and the Host system opener. The details-panel document seat is no longer the product open path.

The [receiving Session materialization note](2026-09-02-receiving-session-arrival-materialization.md) still owns Host Session creation and brief injection. The [Host receiver ledger](2026-08-31-host-owned-member-question-receiver-ledger.md) still owns persistence, first claim, and human-turn reservation.

## Alternatives considered

**Keep the T6 details-panel document seat as the product open path.** Rejected because markdown, sandboxed HTML, and unsupported types already have Files viewers, and a second dock disagrees with stories 33–35.

**Write transferred bytes over the asking Session's Workspace-relative path.** Rejected because a same-named local file would be overwritten or opened by mistake.

**Store document bodies in the receiver ledger.** Rejected because Companion document transfer owns those bytes, and the ledger already excludes referenced bodies.

**Always call `ctx.workspaces.openPath` and let Better Sidebar intercept.** Rejected because a missing Files viewer must fall back to the system opener without a second in-product dock, and the chip must name the receiving Session rather than the current Session.

## Consequences

A receiver reads the transferred copy through the ordinary Files viewer of the receiving Session. Local Workspace files with the same basename stay untouched. A composition without Files uses the Host system opener.

## Testing

Focused cache tests pin hidden-directory writes and same-name isolation. Receiver ingest tests pin transferred bytes on the materializer without ledger bodies. Client plugin tests pin Files `openFile` with the receiving Session id and system-opener fallback. Keyless Web assembled coverage and the owning snapshot prove Files-sidebar opening and same-name isolation.
