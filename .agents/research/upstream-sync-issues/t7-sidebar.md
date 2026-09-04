## Parent

Part of #{{PARENT}}.

## Starting point

Start from the remote upstream-sync baseline after #{{T5}} and #{{T6}} merge.

## Outcome

Refresh the pinned Better Sidebar source from 0.16.1 to 0.18.0 on the stabilized DSH 0.1.2 Client/controller architecture, replay every local modification, and retain the approved canonical Conversation-based Side Chat.

## What to build

- Apply the source delta from `f9153dfc1ce47cf43445c1b351ee3ae47b4ad9f1` to `f59ffd07417036baf3953310d42c7b40b280db78` exactly as `packages/client/ui-better-sidebar/UPSTREAM.md` specifies, limited to `dsh.plugin.json`, `src`, and `tsdown.config.ts`.
- Adopt upstream split-sidebar modules, locale chunk, shared polling primitive where still used, changes panel/diff model, theme palette, workspace fence, performance work, and DSH 0.1.2 adaptations.
- Replay all tracked rows in `LOCAL-MODIFICATIONS.md` and its Chinese pair, updating paths after upstream file extraction.
- Retain the fork Side Chat protocol and implementation: canonical `conversation` mount, provisional tab, first-prompt Host creation, complete composer/approval/permission capabilities, cold model restoration, durable tab recovery, and transactional archival close.
- Remove the upstream parallel Side Chat transcript/polling renderer and its now-unused locale/CSS assets. Preserve user-visible blocks/usage/connection behavior only when it comes through the canonical Conversation renderer.
- Use the new `remote.session.openWorkspacePath` interception path while preserving Gestalt deliverables return, loopback policy, agent-open delivery isolation, Desktop overlay/chrome behavior, and descriptive locale exports.
- Add the locale chunk to the fork build faces and prove the Host serves it.

## File ownership

Own only `packages/client/ui-better-sidebar/**` and the directly owning snapshot/version notices. Do not edit shared Client foundation, controllers, Desktop/Mobile/Platform code, root lock/config files, or global generated artifacts.

## Non-goals

- No upstream standalone Side Chat history-menu/soft-close product.
- No compatibility fallback to `window.__DSH_MODULES__`.
- No unrelated Workbench behavior changes.

## Acceptance criteria

- [ ] `UPSTREAM.md` pins `f59ffd07417036baf3953310d42c7b40b280db78` / 0.18.0 and the imported source matches the allowed upstream paths.
- [ ] Every local modification has an explicit retained, upstreamed, relocated, or retired disposition.
- [ ] Side Chat satisfies Issue #245 and the approved restore/close behavior on the new mount interface.
- [ ] `client-locale.js` is built and served; all locale catalogs typecheck and the fallback-parity check passes.
- [ ] Changes/files/browser/free-window/Desktop-overlay flows and open-path interception have focused Client tests and keyless assembled Web evidence.
- [ ] Agent Note, README/JSDoc, bilingual local-modification docs, and product-visible snapshot/GIF evidence land.

## Dependencies

Blocked by: #{{T5}}, #{{T6}}.
