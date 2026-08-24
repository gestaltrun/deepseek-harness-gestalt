# Agent Note: Side Chat Owned Admission and Header Actions

Status: implemented

English | [中文](2026-08-24-side-chat-owned-admission-and-header-actions.zh.md)

## Problem

Side Chat reuses the canonical Session conversation UI but its child Agent is owned by subagent routing. Generic Session RPCs reject that identity, while opening a provisional tab must not create an Agent. Treating the provisional renderer identity as a durable subagent also changes parent counts before the user sends a message. Header actions and their document-local popovers additionally assume the full conversation width and can be clipped inside the right sidebar.

## Decision

`SessionAdmissionAdapter` carries every operation whose admission depends on Session ownership: prompt, cancellation, queued-message mutation, command handling, skill-catalog addressing, and model routing. The Side Chat adapter serves child-owned operations through `dsh-better-sidebar` routes. Before first submission, the skill catalog uses the parent Session and model selection remains renderer-owned; first submission creates the child under the provisional id with the parent's current Agent options. A provisional permission command addresses the live parent's ordinary command executor, while the Side Chat route validates a published child's parent before applying the preset to both Agents. The provisional child receives the updated parent options at creation. A catalog cache entry records its resolved Session identity and is replaced when publication moves ownership from parent to child.

Feature-owned operations never fall through to ordinary Session RPCs. Side Chat exposes its supported permission command through the adapter and omits the generic command catalog, so the shared `/` launcher shows its skill candidates without advertising commands that the Side Chat owner cannot execute.

Provisional summaries carry an explicit marker. Side Chat classifiers recognize that marker or the reserved title, while descendant indexing excludes the marker until the Host publishes the Session. Durable origin and parent fields become authoritative after publication.

The shared composer plus button opens every registered `/` trigger source in the existing grouped menu. Side Chat keeps title and breadcrumb navigation absent, then contributes the rendered child's descendant catalog as its first header action, followed by background jobs and schedules. Descendant selection retargets the explicit Side Chat renderer instead of calling the shell-level subagent opener; the tab retains its root child id for live-handle disposal. Job and schedule lists render through viewport portals whose right edge follows the trigger and whose left edge is clamped to the viewport. Both use the primitives package's anchored-position and outside-pointer hooks, which treat the trigger root and its portal as one owned surface.

## Alternatives considered

**Use ordinary Session RPCs for the embedded child.** Rejected because those routes do not own subagent Agents and their ownership checks correctly refuse the request.

**Create the child when the tab opens.** Rejected because viewing an empty Side Chat would acquire runtime resources and alter durable topology without a user message.

**Build Side Chat-specific composer and header components.** Rejected because it would duplicate queue, permission, skill, model, transcript, and accessibility behavior already owned by the canonical conversation packages.

**Hide unsupported controls in Side Chat.** Rejected because queue steering, permissions, skills, descendant navigation, jobs, and schedules all have a child-scoped owner and can retain the shared UI when routed explicitly.

## Consequences

Side Chat has one canonical conversation component tree and one feature-owned admission path. Opening a tab is topology-neutral until first submission; model and catalog interaction do not publish a Session. Provisional permission changes use the parent's owned command path, published changes remain synchronized with the direct parent, and queue edits and steering reach the live child inbox. Compact headers expose only the rendered child's descendants; selecting one keeps the shell's main Session and the Side Chat tab intact, while task lists remain visible at narrow sidebar widths. Each new feature-owned Session operation must use an owner that can validate the addressed identity.

## Testing

Runtime and package tests pin adapter routing, provisional topology exclusion, grouped trigger launch, model selection, queue steering, permission ownership, catalog-owner transitions, child-scoped header actions, local descendant retargeting, root-handle disposal, and viewport popover placement. The assembled Web replay selects Side Chat from a fresh pane, reads a seeded skill before child creation, submits the first message, changes the model, synchronizes permission to parent and child, retargets to a nested descendant, verifies both transcripts, and closes the tab through the retained root handle.
