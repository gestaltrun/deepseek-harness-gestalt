# Agent Note: Fused high-fidelity UI prototype variants

Status: implemented

English | [中文](2026-09-02-fused-ui-prototype-variants.zh.md)

## Problem

UI prototypes in this repository followed the upstream Matt default: several structurally different skins, often on a vacuum route, with captions and a switcher treated as part of the page. New Gestalt functions almost always land inside an existing Settings, Desktop, or account-pool chrome, so a parallel kit taught the wrong density. Agents also drew those drafts in the coordinating session and opened headed windows to decide whether the draft was ready, filling context and leaving leftover Electron instances.

## Decision

[`prototype/UI.md`](../../../skills/prototype/UI.md) still requires several interaction variants. Each variant fuses the new function into the host page and the current component library. Sub-shape A — the existing route, `?variant=` on that route, mock data for the new function — is the default. Captions, grilling notes, and the switcher bar are scaffolding; the headed review shows only the high-fidelity composition.

The prototype session is not the coordinating session. [`orchestrate-dsh-delivery`](../../../skills/orchestrate-dsh-delivery/SKILL.md) dispatches an isolated Codex worktree task or DSH subagent with a short brief. That session self-checks every variant headless through [`dsh-desktop-test-instance`](../../../skills/dsh-desktop-test-instance/SKILL.md), then starts a headed instance only to ask the user to review. [`to-spec`](../../../skills/to-spec/SKILL.md) links the frozen draft, throwaway branch, and experience route; it does not publish a UI spec without those. Implementation then compares the running product to that draft in [the fidelity-and-acceptance-route decision](2026-09-03-ui-fidelity-and-acceptance-route.md).

## Alternatives considered

**Keep the upstream "radically different skins" default.** That answers "what else could this be" but abandons the chrome the function will ship in. Interaction diversity still lives in layout and affordance; visual language stays the host page.

**One high-fidelity draft, no variants.** That under-explores a new function. Variants remain; they stay fused.

**Draw the prototype in the coordinating grill session.** The session already holds tracker state and implementation context. A separate worktree keeps the draft cheap to throw away.

**Headed-first self-review.** A visible window is for the user. The agent can tell whether chrome and components fused while headless.

## Consequences

Prototype branches stay planning input, not production history. Implementation tickets rewrite the winning variant against tests and lifecycle rules. Specs cite a frozen draft and an experience route instead of restating layout. Coordinating sessions stay smaller because they do not host the drawing loop. Implementation still has to compare the running product to that draft before headed review.
