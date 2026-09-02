# Agent Note: Desktop assemblies expose roster lookup and routed ask through a live-login resolver

Status: implemented

English | [中文](2026-09-02-desktop-roster-routing.zh.md)

## Problem

Tickets #342 and #343 shipped `project_members` and `ask_user_question.to_project_member` as injectable Consumers. A real Desktop assembly still did not expose them together: Account proofs stay in Electron main, the Web Host Agent cwd is not an identity source, and T5's `originResolver` forwarded the model-supplied `to_project_member` string as if it were already an Account id. A bound session could therefore invent an addressee, skip the live roster, and fall back to the local ask tool.

## Decision

A Cloud-Project-bound Desktop session exposes `project_members` and `ask_user_question.to_project_member` together. Electron publishes a token-protected loopback read projection of the current Installation Account, the Workspace-bound Cloud Project, and one complete roster with public GitHub logins. The Web Host provider `ctx.desktopProjectMembership` reads that projection; agent presets inject it as `currentAccountResolver`, `boundProjectResolver`, `rosterResolver`, `rosterPresenter`, and `routeResolver`. Browser-only `dsh web` has no projection and therefore omits `project_members` and hides `to_project_member`.

`ask_user_question` no longer invents a Project or origin. A routed ask requires `routeResolver`, which returns a Project, origin, and matched Account id only when the current roster contains the addressee. Public login matching is case-insensitive against the roster's `displayName`. An absent member answers `INELIGIBLE_ADDRESSEE` before delivery; a missing sender or resolver answers `SENDER_UNAVAILABLE`. Tests and the model-visible path must not inject Account ids to skip that lookup. Account identity is sampled from the current Installation snapshot, not from Agent cwd. Tool and prompt-assembly cancellation signals abort the resolver through the Web Host fetch and Desktop Platform reads.

## Alternatives considered

**Keep `originResolver` and treat `to_project_member` as an Account id.** Rejected: the model-visible path is roster lookup then routed ask, and public GitHub login is the operator-facing identifier. Forwarding an invented Account id would skip the live roster.

**Sample Account identity from Agent cwd or a test-injected Account id.** Rejected: Platform Account belongs to the current Installation. Cwd selects only the Workspace whose Git remote binds a Cloud Project.

**Mount `project_members` in browser-only `dsh web`.** Rejected: that composition has no Account proof owner and no loopback projection, so the tool would either invent identity or fail closed on every call.

## Consequences

Bound Desktop sessions never fall back to the local ask tool when `to_project_member` is present. Unbound sessions hide the routing parameter. Arbitrary non-roster addressees fail closed. The loopback projection is read-only; Project mutations remain renderer-to-Desktop IPC.

## Testing

`packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts` pins public-login routing, `INELIGIBLE_ADDRESSEE` before delivery, and cancellation through `routeResolver` and `boundProjectResolver`. `packages/platform/project-membership-desktop/tests/desktop-provider.spec.ts` pins case-insensitive login matching and abort of pending loopback reads. `apps/desktop/tests/project-membership-agent-runtime.spec.ts` pins Installation-sampled identity, actor mismatch, account-switch refusal, and quiescent disposal. `examples/project-members` keyless snapshot replay pins `project_members` then `ask_user_question` with `to_project_member` set to the live public login, not an Account id.
