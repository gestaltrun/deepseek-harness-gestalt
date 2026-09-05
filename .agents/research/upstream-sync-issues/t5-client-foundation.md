## Parent

Part of #{{PARENT}}.

## Starting point

Start from the remote upstream-sync baseline after #{{T1}} and the provisional Session binding prerequisite merge. The independent renderer slice may be developed in parallel, but provisional/cold acceptance and final merge wait for that controller prerequisite.

## Outcome

Make the upstream Client store/session/renderer architecture the only Client foundation, port the fork's explicit Session mount interface onto it, and delete `dsh-client-runtime` without yet adapting all Gestalt product plugins.

## What to build

- Preserve upstream `dsh-client-store`, `dsh-client-ui-session`, `dsh-client-ui-renderer`, `dsh-client-ui-chat`, `dsh-client-ui-conversation`, controller Client bindings, standard props, and combo boot.
- Implement explicit Session rendering through the existing session adapter `resolve(key)`: add the binding provider, Slot renderer entry, fail-loud slot checks, and `ctx.uiRenderer.mountSession(container, slotKey, sessionId, ownerProps)` disposer interface.
- Restore the `conversation` owner props needed by Side Chat (`renderMode`, `openSession`) without reverting upstream `SessionAreaProps.children: ReactNode` or the new binding/store architecture.
- Preserve provisional Session rendering and cold opening as explicit owned behavior, with tests for missing bindings, root-scoped slots, disposal, and selected-Session isolation.
- Port shared upstream Client packages away from any remaining `dsh-client-runtime` imports. Relocate only fork abstractions with current consumers (`SessionAdmissionAdapter`, `SessionModelRoute`, and `MemberQuestionRecordView`) to the narrow owning modules; do not recreate a generic runtime barrel.
- Delete `packages/client/runtime` after shared clients and explicit mounts compile.

## File ownership

Own `packages/client/store/**`, `packages/client/ui-session/**`, `packages/client/ui-renderer/**`, `packages/client/ui-slots/**`, `packages/client/ui-chat/**`, `packages/client/ui-conversation/**`, shared Client packages that upstream already migrated, and `packages/client/runtime/**` for deletion. Do not edit Gestalt-only UI plugins (`ui-better-sidebar`, `ui-workbench`, `ui-member-questions`, `ui-browser`, `ui-desktop`), Desktop/Mobile/Platform/Browser product packages, Member Question Host packages, controllers, root configs, or Better Sidebar snapshot files.

## Non-goals

- No Side Chat product wiring or Better Sidebar refresh.
- No Desktop/Mobile/Platform adaptation.
- No second Client session store or compatibility barrel.

## Acceptance criteria

- [ ] `mountSession` renders a non-root Session slot for the explicit Session id without changing the shell-selected Session and returns a disposer that releases its React root and subscriptions.
- [ ] `conversation` receives Side Chat owner props on the upstream binding architecture.
- [ ] Upstream shared Client packages compile without importing `dsh-client-runtime`.
- [ ] `packages/client/runtime` is absent and no shared Client package depends on it.
- [ ] Focused Client tests cover explicit binding, provisional rendering, Host publication upgrade, disposal, and HMR cleanup.
- [ ] The architectural Agent Note, package README/JSDoc, Client subsystem docs, slot catalog source, and keyless assembled Web snapshot land.

## Dependencies

Blocked by: #{{T1}} and the provisional Session binding prerequisite.
