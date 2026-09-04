## Parent

Part of #{{PARENT}}.

## Starting point

Start from remote baseline `codex/feature-upstream-sync` at `c68bc4b3bb9c292dd8d399ac337b6980d632caf4`. The ancestry graft and upstream merge already exist. Do not repeat or rewrite them.

## Outcome

Make the merged workspace installable and give every retained package the correct Host/Client compiler face before feature migration begins. This ticket owns shared build metadata so later workers receive reliable errors instead of missing-project and stale-install cascades.

## What to build

- Repair root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.host.json`, `tsconfig.client.json`, and aggregate project references for the merged workspace.
- Preserve upstream Zod 4 and Session projection definitions. Reinstall/relink packages so workspace packages resolve Zod 4 rather than stale Zod 3 links; change source only for genuine v4 typing failures that remain after a clean install.
- Restore compiler faces for Gestalt-only Platform, Browser Runtime, Member Question, Desktop, and Mobile packages without reintroducing deleted upstream packages.
- Make `pnpm install --frozen-lockfile` complete in a clean checkout. Platform-specific optional packages may warn, but required packages and package-local links must exist.
- Remove any remaining package metadata produced by rename/rename collision or deleted SQLite Session persistence.
- Keep Knip removed.

## File ownership

This ticket exclusively owns root manifests, root TypeScript configs, workspace dependency locking, and package `tsconfig*.json` files needed only to register project faces. It may adjust package manifests solely for dependency/link correctness. It must not change runtime behavior in Tools, Session, controllers, UI, Desktop, Mobile, Platform, or Browser packages.

## Non-goals

- No ApiProxy or client-runtime migration.
- No tool, subagent, Member Question, Agent Teams, Side Chat, Desktop, Mobile, Platform, or Better Sidebar behavior changes.
- No compatibility alias for deleted SQLite Session persistence.

## Acceptance criteria

- [ ] Clean checkout: `pnpm install --frozen-lockfile` exits 0.
- [ ] No tracked file contains a merge marker or package metadata for another package.
- [ ] All missing-project `TS6307` diagnostics caused only by absent aggregate/package references are gone from direct Host and Client TypeScript builds.
- [ ] Zod projection diagnostics are rechecked after clean relinking; no source workaround is added for a stale installation tree.
- [ ] Root package/workspace/reference files contain current upstream structure plus every retained Gestalt package.
- [ ] A focused build-graph or workspace-constraint test rejects an omitted Gestalt compiler face.
- [ ] Required README/JSDoc changes and a non-trivial Agent Note land with the implementation.

## Evidence

Run and report only relevant checks selected by `dsh-pre-push-checks`, including clean frozen install, direct Host/Client TypeScript programs, workspace constraints, and the focused build-graph test.

## Dependencies

None. This is the blocker for all other migration tickets.
