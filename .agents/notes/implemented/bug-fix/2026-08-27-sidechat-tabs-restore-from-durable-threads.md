# Agent Note: Side Chat tabs restore from durable thread sessions after restart

Status: implemented

English | [中文](2026-08-27-sidechat-tabs-restore-from-durable-threads.zh.md)

## Problem

A Side Chat thread is a durable child Session (subagent origin, `Side: ` label), but the strip tab referencing one lived only in localStorage, which is origin-scoped. The desktop Web Host binds an OS-assigned port on every launch, so each restart changes the origin and orphans the strip: subagent sessions reappear because their catalog is enumerated from the Host's durable session data, while side threads kept no UI path back — they are deliberately filtered out of the subagent topology ("tab-strip conversations, never topology") — even though their transcripts persist on disk. Closing a tab also releases only the live Agent, so the data of a deliberately closed thread persists identically.

## Decision

The strip reconciles against the sessions list feed (`packages/client/ui-better-sidebar`). When a session's sidebar state activates, `restorableSideThreads` collects the session's published direct side threads (subagent origin, `Side: ` label, non-blank, not renderer-provisional) and `reconcileSideThreads` opens a tab for every thread that has none. Restored tabs carry `meta.threadId` without the provisional flag, so the existing view path mounts the conversation and the existing `sidechat.prompt` route cold-resumes the thread. Restores land in the active pane without stealing its active tab; an empty pane activates the first restored thread. A restore also reopens a collapsed panel so it is visible — the narrow viewport's full-screen drawer stays closed (mirroring the loadState first-paint rule).

A user close tombstones the thread: `closeTab`/`closeFloatByTab` append the tab's root thread id to the state's persisted `closedSideThreads`, and the reconcile never resurrects a tombstoned thread. The `?dsh-sidebar-reset` escape hatch skips restoration for that load, so the reset still breaks a mount-hang loop when the hanging tab is a side chat. The tab-meta thread readers moved from the view into the shared `sidechat-core` module so the pure state layer reads thread identity without importing a component.

## Alternatives considered

**Pin the desktop Web Host to a remembered port.** Repairs only the desktop and only until the port is occupied; browser `dsh web` on a custom port keeps the same failure. The durable thread list is the better authority regardless.

**Persist the strip Host-side.** A new per-session UI-state store just to survive origin changes; the thread data is already durable and sufficient, so this buys nothing over reconciling from it.

**List side threads in the subagent catalog for manual reopening.** Reverses the recorded "never topology" classification and still leaves the user's strip empty on every restart; restore must be automatic.

**No tombstones.** A closed thread would reopen on the next restart — closing releases only the live Agent, never the durable Session, so an explicit close must outlive restarts.

## Consequences

Restarting the app with a side conversation in use restores its tab with full history, and the thread can continue. Restoration is additive only — the strip never drops a tab because a thread left the list feed — so late-arriving baselines and reconnect churn cannot fight the user's layout. Tombstones are per-session and unbounded but grow only with deliberately closed threads. The vendored snapshot records the divergence in `LOCAL-MODIFICATIONS.md`. Package tests pin the collector filters, the reconcile placement and idempotence, both close paths' tombstoning, the sanitize round-trip for older persisted states, and the reset-hatch skip.
