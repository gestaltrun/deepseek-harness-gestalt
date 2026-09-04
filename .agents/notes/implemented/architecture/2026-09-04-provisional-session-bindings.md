# Agent Note: Controller-owned provisional Session bindings

Status: implemented

English | [中文](2026-09-04-provisional-session-bindings.zh.md)

## Problem

Explicit Session mounts must render a caller-supplied identity before a Host Session exists, then keep that same identity after Host publication, without changing shell selection. Upstream `ClientSessions.binding(id)` resolved only listed or current ids, and `followCurrent()` coupled history open to `list.current`. A temporary client-runtime implementation owned staging, publication, and cold open together with feature admission routing, so a renderer or product plugin would otherwise recreate Session list projection.

## Decision

`@deepseek-ai/dsh-api-session-controller` owns the Client provisional identity lifecycle on `ctx.sessions`. `binding(id)` stays a render-safe lookup: it may mint a local scope for an eligible id, and it never opens Host history or refreshes a catalog. `stageProvisional()` extends controller-owned list eligibility with one caller-supplied blank subagent row, mints the ordinary `SessionBinding`, and leaves `list.current` unchanged. Duplicate staging of a still-staged or already listed identity fails loud; there is no shared second owner. A Host list refresh keeps unpublished provisional rows and, when the Host baseline already lists the id, publishes it in place while preserving the same binding. `openForRender(id)` is the explicit-render Host I/O: it skips history while the identity is provisional, and after Host publication it opens that Session's history and refreshes its subagent catalog without selecting it. An unknown identity is a no-op, matching the former explicit-render open. Publication deletes the provisional marker and reuses the same manager Session, scope, and binding. The returned disposer removes an unpublished row and its Agent scope exactly once, including before the first successful Host list baseline, and no-ops after publication or a prior release. A provisional upsert or remove recorded during an in-flight list pull does not replace or delete a Host row that publishes the same id. Host fields remain the publication.

Widening public `ISessions` also updates the test-support `TestSessions` double and one `satisfies ISessions` UI conversation fake so the compiler face stays closed. `TestSessions.stageProvisional()` mints the ordinary fixture binding and scope; the conversation fake only stubs the new methods. Production Host publication stays on ClientSessions.

The renderer consumes only `UiSession.adapter.resolve(sessionId)`. Feature-owned admission, model, command, and skill routing remain outside this lifecycle. [Explicit Session slot mounts](2026-08-23-explicit-session-slot-mounts.md) own the mount tree; [Client Session ownership](2026-08-20-client-session-conversation-ownership.md) owns the ordinary binding and scope fiber.

## Alternatives considered

**Keep staging in `dsh-client-runtime`.** Rejected because the Client Session list, scope, and binding already live in the Session Controller; a second store would recreate publication and prune races.

**Select the explicit Session before rendering.** Rejected because a secondary mount must not replace the shell's selected Session, workspace, or workbench state.

**Share one silent owner for duplicate staging.** Rejected because two features staging the same identity would hide the conflict; failing loud names the colliding id.

**Open Host history for a provisional identity.** Rejected because no Host Session or log exists until publication; a history request would fail or create an empty durable window the disposer could not own.

## Consequences

Side Chat and other explicit mounts can stage a preallocated id, resolve ordinary Session-scoped sources, and keep that binding across Host publication without a second Session store. Admission adapters, first-prompt Host creation, and renderer slot mounting stay in their owning packages. Plugin disposal still drops remaining provisional scopes with the rest of the Client Sessions service.

## Verification

Focused ClientSessions tests pin staging without selection, `binding()` without Host I/O, skipped Host history, list-refresh survival, Host-list publication identity, in-flight refresh races including a stale provisional upsert or remove against a publishing baseline, pending-phase release, unknown `openForRender()` no-op, publication identity stability, release-once and post-publication no-op, duplicate-staging failure, published cold `openForRender()`, and HMR/plugin disposal. The test-support `TestSessions` double stages a resolvable binding and treats a later disposer as a no-op after publication.
