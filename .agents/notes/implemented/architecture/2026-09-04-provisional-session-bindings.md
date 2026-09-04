# Agent Note: Controller-owned provisional Session bindings

Status: implemented

English | [中文](2026-09-04-provisional-session-bindings.zh.md)

## Problem

Explicit Session mounts must render a caller-supplied identity before a Host Session exists, then keep that same identity after Host publication, without changing shell selection. Upstream `ClientSessions.binding(id)` resolved only listed or current ids, and `followCurrent()` coupled history open to `list.current`. A temporary client-runtime implementation owned staging, publication, and cold open together with feature admission routing, so a renderer or product plugin would otherwise recreate Session list projection.

## Decision

`@deepseek-ai/dsh-api-session-controller` owns the Client provisional identity lifecycle on `ctx.sessions`. `stageProvisional()` inserts one caller-supplied blank subagent row, mints the ordinary `SessionBinding`, and leaves `list.current` unchanged. Duplicate staging of a still-staged or already listed identity fails loud; there is no shared second owner. A Host list refresh keeps unpublished provisional rows. `openForRender(id)` skips Host history while the identity is provisional; after Host `session-added` publication it opens that Session's history and refreshes its subagent catalog without selecting it. Publication deletes the provisional marker and upgrades the same list row and binding in place. The returned disposer removes an unpublished row and its Agent scope exactly once and no-ops after publication or a prior release.

The renderer consumes only `UiSession.adapter.resolve(sessionId)`. Feature-owned admission, model, command, and skill routing remain outside this lifecycle. [Explicit Session slot mounts](2026-08-23-explicit-session-slot-mounts.md) own the mount tree; [Client Session ownership](2026-08-20-client-session-conversation-ownership.md) owns the ordinary binding and scope fiber.

## Alternatives considered

**Keep staging in `dsh-client-runtime`.** Rejected because the Client Session list, scope, and binding already live in the Session Controller; a second store would recreate publication and prune races.

**Select the explicit Session before rendering.** Rejected because a secondary mount must not replace the shell's selected Session, workspace, or workbench state.

**Share one silent owner for duplicate staging.** Rejected because two features staging the same identity would hide the conflict; failing loud names the colliding id.

**Open Host history for a provisional identity.** Rejected because no Host Session or log exists until publication; a history request would fail or create an empty durable window the disposer could not own.

## Consequences

Side Chat and other explicit mounts can stage a preallocated id, resolve ordinary Session-scoped sources, and keep that binding across Host publication without a second Session store. Admission adapters, first-prompt Host creation, and renderer slot mounting stay in their owning packages. Plugin disposal still drops remaining provisional scopes with the rest of the Client Sessions service.

## Verification

Focused ClientSessions tests pin staging without selection, skipped Host history, list-refresh survival, in-flight refresh races, publication identity stability, release-once and post-publication no-op, duplicate-staging failure, published cold `openForRender()`, and HMR/plugin disposal.
