# Agent Note: project_members resolves identity through config-injected provider faces

Status: implemented

English | [中文](2026-08-28-project-members-roster-tool.zh.md)

## Problem

Ticket #342 wants one model-facing `project_members` read that returns the full project-membership roster — account reference, display identity, role, function tags, presence — while the membership Service Definition's `roster(actor, projectId)` needs an authenticated `PlatformAccountId` the tool cannot obtain: that id lives behind `ctx.platformAccount`, whose sessions are bearer-token-plus-proof presentations the agent loop does not hold. The tool also needs the workspace→project binding and the presence/identity decoration that #340 placed in the HTTP consumer, and the tool package must not grow a dependency on any platform package, or the model-facing surface drags the Desktop/Mobile identity plane into every composition that loads it.

## Decision

`tool-project-members` depends only on the membership Service Definition and takes four optional Config functions: `currentAccountResolver` for the session-bound account, `boundProjectResolver` for the workspace-bound project when the call omits `projectId`, `rosterResolver` for a composition-owned authenticated roster bridge, and `rosterPresenter` for presence plus display identity over one roster read. Account, project, and roster resolvers receive the current Agent and tool cancellation signal. A call resolves the account first and the binding second, so a composition with neither face answers `ACCOUNT_UNAVAILABLE`; unresolvable bindings answer `PROJECT_UNBOUND`; both are stable `HarnessError` codes whose pinned model-facing text names the code, and resolver rejections chain their cause. Without an injected presenter every member reads `presence: "offline"` with no identity fields — the same verdict a composed presence registry with no live heartbeats produces, so the model never sees a third "unknown" state. Absent faces fail at call time, not at registration: the tool registers whenever `ctx.tools` exists and then reads either the injected bridge or `ctx.projectMembership`. The package lives in `packages/interaction/` — the model-facing human-collaboration plane, next to `tool-ask-user` — rather than `packages/platform/`, whose charter is installation-independent identity and session behavior, not agent tooling; the `tool-*` leaf name keeps the `packages/*/tool-*` catalog guard glob authoritative.

## Supersession check

Neither platform note is superseded. [The project-membership authority note](2026-08-27-project-membership-core.md) keeps owning role gates and roster authority; the tool reads `roster()` or an injected authenticated bridge and adds no permission surface. [The Desktop roster-routing note](2026-09-02-desktop-roster-routing.md) owns Installation-sampled identity and the Desktop loopback projection that supplies those faces. [The presence-heartbeats note](2026-08-28-member-presence-heartbeats.md) keeps owning presence semantics and aggregation; the tool consumes a presenter's verdicts and deliberately does not re-derive presence, so "offline absent a presenter" is a presentation default, not a competing liveness source.

## Alternatives considered

**Read the account from `ctx.platformAccount` directly.** Rejected: the tool would import a platform package, coupling a model-facing tool to the identity plane, and the loop holds no bearer token or proof a tool could present — the injection point would be fictional.

**Promote presence and identity into the Service Definition's `roster()`.** Rejected for this milestone: it widens the seam for one consumer, and #340's HTTP consumer already decorates rosters the other way; the presenter keeps the tool decoupled while the platform composition decides which decoration source to wire.

**Default presence to a distinct value (for example `unknown`).** Rejected: the output schema would grow a third state the presence plane never produces, and the model gains nothing — a member with no live heartbeat is offline for every decision the roster serves.

**Ship the tool in the `dsh-base` bundle.** Rejected: no shipped default composition provides `ctx.projectMembership`, so the row would be inert; registration rides the platform composition that supplies the service, as with the acceptance assembly still to land.

## Consequences

The tool is complete and testable today against stub faces. Desktop assemblies inject the loopback provider faces; browser-only `dsh web` still sees `ACCOUNT_UNAVAILABLE` or an omitted tool rather than a roster. The resolver contracts are plain functions in Config, so `cordis.yml` supplies them as `!!js` expressions and tests inject stubs without a plugin — but nothing validates a resolver's identity beyond its signature, and a composition that injects the wrong account's resolver gets that account's roster. The in-memory provider and stub resolvers in the package tests are the reference for the assembled platform face.

`ask_user_question.to_project_member` matches `project_members.displayName` (public GitHub login) on a row whose `self` is false, never `accountId` and never the asking account. The roster marks the asking session account with `self: true`. Routing that login fails with `SELF_ADDRESSEE` before delivery.

## Testing

`tests/tool-project-members.spec.ts` pins the canonical JSON shape, the presenter contract, both stable error paths (including chained causes and the account-before-binding order), config misconfiguration failing at load, and registration disposal. `tests/loader-composition.spec.ts` boots the tool through the real Loader from `cordis.yml` whose `!!js` config carries function-valued faces, proving the injection path and the no-faces error end to end. `examples/project-members` keyless snapshot replay pins the assembled stream-json transcript of one roster read followed by a routed ask whose `to_project_member` is the live public login.
