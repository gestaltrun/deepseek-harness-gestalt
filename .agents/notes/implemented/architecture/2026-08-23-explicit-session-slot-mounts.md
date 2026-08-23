# Agent Note: Explicit Session slot mounts reuse canonical conversation UI

Status: implemented

English | [中文](2026-08-23-explicit-session-slot-mounts.zh.md)

## Problem

A feature shell can keep a secondary Session visible while the application remains selected on another Session. The ordinary slot tree binds every Session-scoped component to shell selection, so rendering the secondary Session by copying transcript, header, and composer components creates a second presentation contract and misses independently registered conversation actions.

## Decision

The runtime exposes `renderSessionSlot()` and ui-renderer exposes `mountSession()` as framework entry points for a declared non-root Session slot. The mount resolves one explicit Session standard-props bundle, opens its history window, and renders it in an independent React root without changing `sessions.list.current`. The existing declaration ledger, entry boundaries, stores, inject faces, and standard hook binding remain authoritative inside that tree.

Side Chat preallocates a child Session id and stages it as a renderer-only provisional identity before mounting the declared `conversation` slot with `{ renderMode: 'sidechat' }`. Opening the tab creates no Host Session or Agent. The first submitted message atomically creates both under the preallocated id, captures the parent history, installs the selected model, and admits the prompt; Host publication upgrades the provisional row in place. The better-sidebar package owns only this child creation and lifecycle, with no in-tab thread switching or promotion chrome. The registered conversation views and `conversation.composer.bar` provide Chat/Trajectory tabs, transcript, actions, and InputBar. `ConversationSessionHeader` uses its Side Chat posture to omit the Session title, lineage navigation, and agent-preset label while retaining child-scoped action entries. The inherited seed stays durable but an `owned-suffix` admission adapter hides it from the child transcript and routes prompt and cancel operations through the Side Chat Agent lifecycle.

Session-scoped header contributions receive the explicit id through the standard kit. Side Chat suppresses lineage navigation and static preset context; schedules still read that Session's `schedules` projection, and background jobs read `jobsBySession[sessionId]`. The better-sidebar terminal is not a conversation-header contribution; it remains scoped by the workbench tab's `SessionScope` and is not implicitly retargeted by an embedded conversation mount.

Model selection resolves through a Session-level feature route. Before first submission, Side Chat validates and retains the choice against the shared catalog; child creation installs that choice in the new Agent scope. After publication, the same route updates the live child without calling the ordinary Session model RPC that subagent routing rejects.

## Render authority

Ordinary child rendering still uses the declaring entry's `renderSlot` prop. Explicit Session mounting requires the injected `uiRenderer` service, rejects `root` and root-scoped targets, and fails when the target declaration or renderer support is absent. This is a feature-shell composition operation, not a second slot-definition or component-import API.

## Alternatives considered

**Keep a Side Chat transcript and composer.** Rejected because it duplicates conversation rendering, input behavior, tool presentation, registered header actions, and accessibility fixes while continuously drifting from the main Session UI.

**Introduce a `ConversationSurface` wrapper.** Rejected because the declared `conversation` slot already composes `ConversationSessionHeader`, `ConversationSession`, and `conversation.composer.bar`; another wrapper would name the same assembly without owning new behavior.

**Select the Side Chat Session before rendering.** Rejected because a side conversation must remain visible without replacing the main Session selection or its workspace and workbench state.

## Consequences

Side Chat deletes its custom transcript mapping, polling, message rows, composer CSS, and thread-management toolbar while gaining canonical conversation views and input behavior automatically. Its compact header gives up title and lineage navigation so the narrow panel starts at view selection, but Session-owned schedules and background jobs remain available. A secondary mount keeps its own React-root lifecycle; while provisional, it opens no Host history window, and its shell must release the provisional row and mount when the tab changes or unmounts. Feature-owned admission and model routing remain necessary because Side Chat Agents do not use the ordinary Session prompt or model routes. Terminal scope remains an explicit workbench concern rather than an incidental consequence of the renderer binding.

## Verification

Renderer tests pin explicit-session binding while the selected Session changes or disappears. Runtime tests pin provisional survival and publication, deferred Agent creation, model-route ownership, first-message admission, prompt and cancel routing, and inherited-seed hiding. Component tests pin the exact `conversation` slot, child Session id, sidechat render mode, absent outer toolbar and preset label, compact header actions and tabs, unchanged main selection, new-tab icon and label, and mount disposal.
