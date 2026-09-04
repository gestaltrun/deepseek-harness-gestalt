## Parent

Part of #{{PARENT}}.

## Starting point

Start from the remote upstream-sync baseline after #{{T3}}, #{{T4}}, and #{{T5}} merge.

## Outcome

Port DeepSeek Gestalt, Mobile Companion, Platform, Browser Runtime, Workbench, and Member Question clients to the upstream controllers and Client foundation while retaining their accepted product behavior.

## What to build

- Replace every Gestalt-only import of `dsh-client-runtime` and ApiProxy with the owning controller/store/session/renderer/Remote interface.
- Adapt `ui-workbench`, `ui-member-questions`, `ui-browser`, `ui-desktop`, Desktop, Mobile, Platform, and Browser packages to current package exports, branded ids, compiler faces, and Client Remote namespaces.
- Preserve the accepted Member Question receiving Session, Decision Brief, references, ordinary pre/post-answer conversation, multi-installation settlement, and Files-viewer integration from #338, #516, #517, and #520.
- Switch Desktop Session persistence and assembled tests to the upstream JSONL/handle implementation. Do not restore the removed SQLite Session backend.
- Port the shared HTTP helpers needed by Platform HTTP consumers into one owning Host module rather than copying helpers across consumers.
- Preserve Browser Workspace event projection, lifecycle ownership, and tab recovery while adding `ignorable: true` at its final writer.
- Preserve Desktop Host boot, native chrome, settings overlay, updater surface, process ownership, Platform identity/Personal Pairing, Mobile Companion authority, and Browser Runtime behavior affected by interface migration.
- Do not implement unrelated open Phone/device features; keep their existing behavior compiling and isolate any pre-existing failure.

## File ownership

Own `packages/client/ui-workbench/**`, `packages/client/ui-member-questions/**`, `packages/client/ui-browser/**`, `packages/client/ui-desktop/**`, `packages/client/connection/**` where needed for Gestalt protocol additions, `apps/desktop/**`, `apps/mobile/**`, `apps/platform/**`, `packages/platform/**`, `packages/browser/**`, and the narrowly shared Host HTTP helper owner agreed with #{{T4}}. Do not edit `ui-better-sidebar` snapshot files, shared Client foundation owned by #{{T5}}, controller implementations owned by #{{T4}}, root lock/config files, or global generated artifacts.

## Non-goals

- No Better Sidebar 0.18.0 source refresh.
- No release, signing, notarization, Platform deployment, or update-feed change.
- No completion of unrelated #573–#580 Phone feature scope.

## Acceptance criteria

- [ ] All owned packages compile on Host and Client faces without ApiProxy/client-runtime imports.
- [ ] Desktop starts a real Web Host and connects through generated Remotes.
- [ ] Desktop and assembled tests use real JSONL/handle Session persistence.
- [ ] Member Question end-to-end behavior required by the accepted tickets remains intact on the waterfall/Remote architecture.
- [ ] Browser Workspace, Platform Account, Personal Pairing, Remote Access, Mobile Companion, Workbench files/browser, settings overlay, and Desktop shutdown have focused real-composition tests.
- [ ] Each lifecycle path reaches quiescence and releases processes, listeners, ports, and temporary files.
- [ ] Required Agent Notes, context/package README/JSDoc, bilingual docs, and keyless assembled snapshots land.

## Dependencies

Blocked by: #{{T3}}, #{{T4}}, #{{T5}}.
