# Agent Note: Explicit Session slot mounts reuse canonical conversation UI

Status: implemented

English | [中文](2026-08-23-explicit-session-slot-mounts.zh.md)

## Problem

A feature shell can keep a secondary Session visible while the application remains selected on another Session. The ordinary slot tree binds every Session-scoped component to shell selection, so rendering the secondary Session by copying transcript, header, and composer components creates a second presentation contract and misses independently registered conversation actions.

## Decision

The runtime exposes `renderSessionSlot()` and ui-renderer exposes `mountSession()` as framework entry points for a declared non-root Session slot. The mount resolves one explicit Session standard-props bundle, opens its history window, and renders it in an independent React root without changing `sessions.list.current`. The existing declaration ledger, entry boundaries, stores, inject faces, and standard hook binding remain authoritative inside that tree.

Side Chat mounts the declared `conversation` slot with its child Session id and `{ renderMode: 'sidechat' }`. The better-sidebar package owns only thread creation, switching, promotion, and lifecycle chrome. `ConversationSessionHeader`, the registered conversation views, and `conversation.composer.bar` provide the title, lineage, Chat/Trajectory tabs, transcript, actions, and InputBar. The inherited fork seed stays durable but an `owned-suffix` admission adapter hides it from the child transcript and routes prompt and cancel operations through the Side Chat Agent lifecycle.

Session-scoped header contributions receive the explicit id through the standard kit. Subagent lineage therefore reads descendants of the Side Chat Session, schedule reads that Session's `schedules` projection, and background jobs read `jobsBySession[sessionId]`. The better-sidebar terminal is not a conversation-header contribution; it remains scoped by the workbench tab's `SessionScope` and is not implicitly retargeted by an embedded conversation mount.

## Render authority

Ordinary child rendering still uses the declaring entry's `renderSlot` prop. Explicit Session mounting requires the injected `uiRenderer` service, rejects `root` and root-scoped targets, and fails when the target declaration or renderer support is absent. This is a feature-shell composition operation, not a second slot-definition or component-import API.

## Alternatives considered

**Keep a Side Chat transcript and composer.** Rejected because it duplicates conversation rendering, input behavior, tool presentation, registered header actions, and accessibility fixes while continuously drifting from the main Session UI.

**Introduce a `ConversationSurface` wrapper.** Rejected because the declared `conversation` slot already composes `ConversationSessionHeader`, `ConversationSession`, and `conversation.composer.bar`; another wrapper would name the same assembly without owning new behavior.

**Select the Side Chat Session before rendering.** Rejected because a side conversation must remain visible without replacing the main Session selection or its workspace and workbench state.

## Consequences

Side Chat deletes its custom transcript mapping, polling, message rows, and composer CSS while gaining every canonical conversation contribution automatically. A secondary mount keeps its own React-root lifecycle and history window, so its shell must dispose the mount when the tab changes or unmounts. Feature-owned admission remains necessary because Side Chat Agents do not use the ordinary session prompt route. Terminal scope remains an explicit workbench concern rather than an incidental consequence of the renderer binding.

## Verification

Renderer tests pin explicit-session binding while the selected Session changes or disappears. Runtime tests pin feature admission, prompt and cancel routing, and inherited-seed hiding. The Side Chat component test pins the exact `conversation` slot, child Session id, sidechat render mode, unchanged main selection, and mount disposal.
