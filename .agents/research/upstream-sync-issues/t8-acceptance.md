## Parent

Part of #{{PARENT}}.

## Starting point

Start from the remote upstream-sync baseline after #{{T2}}, #{{T3}}, #{{T4}}, #{{T5}}, #{{T6}}, and #{{T7}} merge.

## Outcome

Converge generated artifacts and documentation, then prove the merged product through repository checks and real Web/Electron user journeys without replacing any DSH component under test with a mock.

## What to build

- Repair root scripts, CI evidence, generators, package inventories, recorded-session ownership, and moved owner-local fixtures.
- Regenerate API, Typert, Client slot, config, persistence, scoped-event, third-party notice, module graph, and website artifacts from owners. Regenerate `pnpm-lock.yaml` from the final package graph.
- Reconcile root `AGENTS.md`, README files, package inventory, context map, and docs so current Gestalt ownership and product terminology coexist with upstream standing rules. Replace ApiProxy/client-runtime/SQLite Session descriptions with the final owners.
- Run the smallest focused checks during convergence, then run the irreducibly repository-wide final suite required by this spec.
- Add or update a WebdriverIO Electron matrix that launches the real built Desktop Host. The Desktop Host must launch the real `dsh web` Web Host and load a real BrowserWindow/renderer using generated Remotes and real JSONL/handle Session persistence.
- Cover clean boot and boot-screen handoff, `window.__DSH_BOOT__`/combo boot, workspace/session navigation, canonical Side Chat first-prompt publication/restart restoration/transactional close, authorized and denied subagent routes, Member Question waterfall/Remote answer and reference opening, ignorable events and Agent Teams v1 upgrade, Better Sidebar file/open-path behavior, settings/overlay, Desktop chrome, and orderly process shutdown.
- Keep the existing real Sub2API and multi-instance Member Question lanes, updating them to the final architecture rather than replacing them with in-process fakes.

## No-mock requirement

The final acceptance must not fake or bypass the Harness Engine/Cordis composition, controller/gateway/Remote transport, Side Chat, Session persistence, Electron preload/IPC, Web Host, or Desktop Host. A deterministic replacement is allowed only for an uncontrolled external boundary (LLM vendor HTTP, GitHub OAuth, public Relay/staging, OS display nondeterminism), and it must run as a separate process or staging service behind the real DSH adapter/controller.

Real-model/OAuth/Relay/Sub2API credentials require explicit authorization. When authorized, copy only required settings/credential files into a fresh gitignored scratch `DSH_HOME`, set directories to `0700` and files to `0600`, never print secrets, scan retained logs/screenshots/video for secrets, delete the scratch home, and verify removal.

## File ownership

Own root scripts and generated artifacts, `snapshots/**`, `apps/web/tests/**`, `apps/desktop/tests/**`, repository/documentation convergence files, and E2E harness changes. Do not change settled runtime behavior from earlier tickets except to fix a demonstrated acceptance regression routed back to the owning ticket.

## Acceptance criteria

- [ ] Clean `pnpm install --frozen-lockfile` succeeds.
- [ ] `pnpm run typecheck`, `pnpm run build`, `pnpm run lint`, `pnpm run hygiene`, `pnpm run doc-sync`, `pnpm run test:coverage`, `pnpm run test:snapshot`, and applicable owner-local expected tests pass.
- [ ] A real `dsh web` smoke proves the assembled Browser application.
- [ ] A real Electron/WDIO run proves every affected user journey listed above through the actual renderer and Host processes.
- [ ] Electron, Web Host, child-agent, platform/relay fixture, and auxiliary owned processes reach quiescence after success and failure.
- [ ] Failure artifacts include sanitized Host/renderer/Web Host logs, WDIO trace/video/screenshots where appropriate, and owned-process state; retained artifacts contain no secret.
- [ ] Product-visible GUI changes include a GIF recorded from the real pull-request server/mode.
- [ ] The final verification comment lists only commands actually run and distinguishes keyless evidence from explicitly authorized external-service evidence.

## Non-goals

No release tag, GitHub Release, registry publication, signing, notarization, deployment, or update-feed mutation.

## Dependencies

Blocked by: #{{T2}}, #{{T3}}, #{{T4}}, #{{T5}}, #{{T6}}, #{{T7}}.
