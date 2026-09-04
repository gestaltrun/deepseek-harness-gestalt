# Spec: Integrate DSH 0.1.2-rc.1 and Better Sidebar 0.18.0 into DeepSeek Gestalt

Status: FINAL. The user approved the upstream ancestry graft, one-baseline staged delivery, deployment-preauthorized subagent routes, the canonical Conversation-based Side Chat, ignorable downstream Session events, Agent Teams v1 log upgrades, removal of Knip, and real Electron end-to-end acceptance.

Delivery baseline: `codex/feature-upstream-sync` at `c68bc4b3bb9c292dd8d399ac337b6980d632caf4`. The baseline already contains the ancestry graft (`47f943859b`) and the mechanical merge of `deepseek-ai/deepseek-harness@76fda72979` (0.1.2-rc.1). Implementations must start from this exact remote baseline and must not repeat or rewrite the merge.

Better Sidebar source: `omdsh-dev/DSH-better-sidebar@f59ffd07417036baf3953310d42c7b40b280db78` (0.18.0), replacing the pinned `f9153dfc1ce47cf43445c1b351ee3ae47b4ad9f1` (0.16.1) snapshot only after the DSH stabilization tickets land.

## Problem

DeepSeek Gestalt carries Desktop, Mobile Companion, Platform, Browser Runtime, Member Questions, canonical Side Chat, and orchestration behavior that do not exist in upstream DSH. Upstream 0.1.2-rc.1 simultaneously replaces ApiProxy with domain Remote controllers, removes `dsh-client-runtime`, introduces Client store/session modules and combo boot, changes Session and projection interfaces, authorizes selectable child models, upgrades Agent Teams records, removes SQLite Session persistence, and moves recorded snapshots. Better Sidebar 0.18.0 targets those upstream interfaces and substantially restructures its own implementation.

The mechanical three-way merge is durable but intentionally not a runnable product state. Direct Host and Client TypeScript programs currently report 973 and 1,513 errors respectively. Most failures are concentrated in retained legacy packages, fork modules that still consume deleted interfaces, independent additions whose package or project metadata were merged incorrectly, and tests or generated artifacts that still describe the pre-merge interfaces.

## Outcome

Deliver one reviewed baseline that preserves Gestalt product behavior on the upstream 0.1.2-rc.1 architecture, refreshes Better Sidebar to 0.18.0, passes repository checks, and proves the resulting application through real Web Host and Electron Desktop Host execution.

## Decisions

### DSH structure

- `packages/host/apiproxy` is temporary preservation evidence only. Port every live Gestalt behavior to the owning Remote/controller module, then delete the package and all dependencies.
- `packages/client/runtime` is temporary preservation evidence only. Existing upstream packages use the upstream controller/store/session modules; Gestalt-only clients port their remaining dependencies, then delete the package.
- SQLite Session persistence stays removed. Desktop and assembled tests use the upstream JSONL/handle persistence architecture. This feature does not promise migration from pre-release SQLite Session stores.
- The upstream Zod 4, projection, snapshot ownership, combo boot, and application-launch interfaces remain authoritative.

### Product behavior retained from Gestalt

- Subagent model routes use the upstream per-Session authorization policy plus a deployment-owned in-memory preauthorization set. Startup must not mutate the user's settings document, and unapproved routes still fail before spawning a child.
- Side Chat renders the canonical `conversation` slot through explicit Session binding. Opening a tab stages a provisional client identity; the first prompt creates the Host Session/Agent; refresh and Host restart restore the thread; close waits for Host disposal and durable archival. The snapshot-owned transcript renderer, polling pipeline, and soft-close history menu do not return.
- Member-directed questions enter `ctx.userQuestions.ask()` and are claimed by a Host waterfall answerer. The sender owns routing and delivery; the receiving Session, Decision Brief, references, settlement, and multi-installation behavior remain the accepted behavior of Spec #338 and tickets #516, #517, and #520.
- Fork-only informational Session events carry `ignorable: true` so an official build can retain and reopen the log without implementing the downstream feature. Agent Teams accepts persisted v1 records and upgrades them to the current v2 in-memory representation.
- Knip remains removed. Existing TypeScript, Oxlint, workspace/dependency, publication, runtime-closure, and package checks own repository validation.

### Better Sidebar

- Refresh only the source files owned by `packages/client/ui-better-sidebar/UPSTREAM.md`, update the pinned upstream SHA/version, and replay every tracked local modification.
- Apply the 0.18.0 split-sidebar, locale chunk, polling primitive, changes panel, theme palette, workspace fence, and DSH 0.1.2 adaptations unless a recorded Gestalt local modification deliberately replaces that behavior.
- Reapply the canonical Side Chat implementation and its transactional restore/close semantics after the source refresh.
- Use `remote.session.openWorkspacePath` on the 0.1.2 controller architecture while retaining the Gestalt deliverables-return behavior.

## Delivery graph

1. Foundation: repair workspace/package metadata, project references, Zod/projection interfaces, and dependency installation.
2. Explicit Session binding prerequisite: restore controller-owned provisional publication, cold rendering, and stable binding identity without changing shell selection.
3. Runtime engines: restore Gestalt tool eligibility/deferred discovery and combine deployment-preauthorized subagent routes with upstream authorization.
4. Interaction and durable records: fuse Member Questions into the waterfall and upgrade Agent Teams v1 records.
5. Remote migration: port Gestalt ApiProxy behavior to controllers/remotes and delete ApiProxy.
6. Client/product migration: port Gestalt-only clients, restore explicit Session mounts and canonical Side Chat, switch Desktop persistence, and delete client-runtime.
7. Better Sidebar refresh and mechanical convergence: refresh to 0.18.0, regenerate catalogs/lockfile, move or rerecord snapshots, and reconcile root documentation/instructions.
8. Final acceptance: run repository checks and a real Electron matrix.

## Acceptance criteria

### Static and package integrity

- `pnpm install` completes from a clean checkout without a missing workspace package or unresolved merge marker.
- `pnpm run typecheck`, `pnpm run build`, `pnpm run lint`, `pnpm run hygiene`, and `pnpm run doc-sync` pass.
- `pnpm run test:coverage` passes the repository's per-file source threshold for changed packages.
- `pnpm run test:snapshot` and owner-local expected-output tests pass after artifacts are regenerated from their owners.
- No tracked file imports `@deepseek-ai/dsh-host-apiproxy` or `@deepseek-ai/dsh-client-runtime`; neither package remains in the workspace.
- The resulting package/version/catalog files contain no conflict markers, stale generated output, or duplicate independent-package metadata.

### Behavior

- Tool eligibility, deferred tool discovery, tool execution, and model-visible tool catalogs retain Gestalt behavior on the upstream Tools interfaces.
- A subagent may use a deployment-preauthorized route without writing settings. An unauthorized route fails before provider execution. Resume uses the Session-recorded policy.
- Member Questions preserve the already accepted roster, routed ask, receiving Session, Decision Brief, references, settlement, expiry, cancellation, supersession, and multi-installation semantics while using the upstream waterfall and Remote controllers.
- Official DSH can open and preserve logs containing fork-only informational events. The merged build can read existing Agent Teams v1 logs and expose the same logical team state through v2 projections.
- Side Chat retains first-prompt Host publication, canonical conversation rendering, complete composer/approval/permission behavior, cold model restore, and transactional archival close.
- Desktop, Mobile Companion, Platform, Browser Runtime, workspace/session navigation, file opening, settings, and Desktop chrome retain their affected behavior after controller/client migration.

### Real end-to-end evidence

The final ticket must drive a real built Electron process through WebdriverIO or the existing Electron service. The test launches the real Desktop Host, which launches the real `dsh web` Web Host, loads a real BrowserWindow/renderer, uses the generated Typert Remotes, and persists Sessions through the real JSONL/handle backend. It must not replace the Harness Engine, controller/gateway transport, Side Chat, Session persistence, or Electron preload/IPC with in-process fakes.

The Electron matrix covers:

- clean startup, boot screen handoff, `window.__DSH_BOOT__`, combo client boot, and absence of the retired `window.__DSH_MODULES__` path;
- workspace/session creation and switching;
- Side Chat provisional tab, first prompt publication, renderer/session restore after Desktop restart, and transactional archival close;
- allowed and denied subagent route selection;
- routed Member Question through the waterfall and generated Remote transport, answer return, and reference opening;
- ignorable downstream events and Agent Teams v1 log upgrade;
- Better Sidebar file/open-path handling, model/settings UI, and Desktop chrome/overlay behavior;
- orderly shutdown with no owned Electron, Web Host, child-agent, or auxiliary process left alive.

Deterministic keyless tests may replace only an uncontrolled external boundary, such as an LLM vendor HTTP endpoint, GitHub OAuth, public Relay deployment, or OS display nondeterminism. Such a replacement must be a separate process or staging service behind the real DSH adapter/controller; it must not replace the DSH module under test. A real-model/staging lane separately verifies provider, OAuth, Relay, or Sub2API behavior when the necessary credentials are explicitly authorized. Tests must use a fresh gitignored `DSH_HOME`, permission directories as `0700` and credential files as `0600`, never print credentials, scan retained artifacts for secrets, and remove the scratch home after the run.

## Documentation and decision records

Each non-trivial child ticket updates its owning Agent Note, package README, JSDoc, subsystem reference, and bilingual pair as required. Generated English catalogs are changed through their generators, not by hand. Root `AGENTS.md`, README files, package inventory, and context routing must preserve current Gestalt ownership while incorporating upstream standing rules.

## Non-goals

- Creating tags, GitHub Releases, publishing packages, signing, notarizing, deploying Platform services, or changing production update feeds.
- Preserving the deleted SQLite Session storage format.
- Restoring Knip.
- Reintroducing Better Sidebar's independent Side Chat transcript and soft-close history model.
- Completing unrelated open Phone/device tickets (#573–#580) unless an upstream migration directly blocks compilation or the final affected-path acceptance.

## Release stop point

Delivery stops after the reviewed baseline-to-master pull request merges and the associated issues close. Release, tag, publication, deployment, signing, and notarization remain subject to separate explicit approval.
