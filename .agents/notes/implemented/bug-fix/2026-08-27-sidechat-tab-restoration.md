# Agent Note: Restore Side Chat Tabs from Durable Sessions

Status: implemented

English | [中文](2026-08-27-sidechat-tab-restoration.zh.md)

## Problem

The Side Chat tab strip is stored in origin-scoped localStorage while each prompted Side Chat is a durable child Session. A Desktop restart can bind a different local port and lose the strip state even though the Host still lists the child Sessions. Restoring every listed child would also reopen conversations that the user deliberately closed.

## Decision

The active Session reconciles its strip against published, direct child Sessions whose durable title starts with `Side: `. Missing unarchived children return as non-provisional tabs in the active pane without replacing an existing active tab. Blank children and renderer-only drafts do not restore. A cold thread restores the model route from its latest child-owned `request/header`, falling back to its creation descriptor before the first request; provisional drafts continue to use the live parent's route. The Host serializes close against any admitted first prompt, reports publication from its live and durable Session stores, and releases the live handle. The client archives a published Session through the Workspace service without deleting its log; an unsent draft has no Session to archive. The tab is removed only after these operations succeed; a failure is reported and leaves it open. Plugin disposal waits for in-flight closes but prevents their late state commits. The local sidebar state then records the closed root thread so list refreshes cannot reopen it before the archive projection arrives. The `?dsh-sidebar-reset` escape hatch disables restoration for that load.

## Verification

Client tests cover candidate classification, archive exclusion, nested-root deduplication, active-pane placement, idempotent list refreshes, apply-lifetime subscription cleanup, branded Session ids, older persisted layouts, the reset escape hatch, cross-Session and plugin-disposal close behavior, first-prompt serialization, release retry, authoritative draft classification, and cold model-route reconstruction. The keyless assembled Web scenario drops the origin-scoped strip, reloads the Host-backed Session, and continues the restored thread. The browser demonstration restarts the pull request's real Web Host on a new port, continues the restored Side Chat through a real model request, and verifies that an archived Side Chat stays closed after another restart.

## Alternatives considered

**Trust only the local close tombstone.** Rejected because the tombstone is lost with the rest of localStorage when the origin changes.

**Persist the complete sidebar layout on the Host.** Rejected because tab restoration needs only durable Side Chat identity; moving every plugin-owned tab payload into a new Host format would broaden the storage agreement.

**Restore every titled Side Chat child.** Rejected because closing a tab would become temporary and every restart would reopen it.

## Consequences

Prompted Side Chats recover from origin changes without moving the general sidebar layout out of browser storage. Closing a published Side Chat also archives it from Workspace grouping surfaces; its Session log remains durable. Restoration depends on the Session list and Workspace archive baselines, so it settles only after both projections arrive.
