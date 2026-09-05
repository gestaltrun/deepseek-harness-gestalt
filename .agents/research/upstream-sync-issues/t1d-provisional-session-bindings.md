## Parent

Part of #585.

## Starting point

Start from the remote upstream-sync baseline after #586 merges. This ticket is a narrow controller prerequisite discovered while implementing #589.

## Outcome

Give the upstream Session controller one identity-stable Client binding lifecycle for explicitly rendered provisional and cold Sessions, without changing shell selection or recreating `dsh-client-runtime`.

## What to build

- Add the smallest `ctx.sessions` operations required by explicit Session rendering: stage a caller-supplied provisional Session identity, resolve its normal `SessionBinding`, open a published cold Session for rendering, and release the provisional stage idempotently.
- Keep Session identity and binding stable when a matching Host `session-added` publication arrives. The Host publication upgrades the same list row and binding in place; a later provisional disposer must not remove the published Session.
- Preserve provisional rows across Host list refreshes until release or publication. A provisional explicit mount never requests Host history. A published cold explicit mount opens history and refreshes its subagent catalog without changing `sessions.list.current`.
- Preserve the upstream controller/store/session architecture. The renderer continues to consume only `UiSession.adapter.resolve(sessionId)` and owns no Session creation, list projection, history, or publication logic.
- Relocate only the provisional binding behavior from the temporary client-runtime implementation. Do not port feature-owned admission, model, command, or skill routing in this ticket.

## File ownership

Own only `packages/api/session-controller/src/client/contract/sessions.ts`, the Client Session manager/service/session code needed for this lifecycle, and directly related focused Client tests and controller README/JSDoc. Do not edit Client renderer/slots/conversation, ApiProxy Host/controller migration, product plugins, root configs, or `packages/client/runtime`.

## Non-goals

- No Side Chat product wiring or first-prompt Host creation.
- No feature-owned prompt/model/command/skill admission adapter.
- No shell selection change and no second Client Session store.
- No ApiProxy deletion or generated Remote method.

## Acceptance criteria

- [ ] Staging a provisional identity makes `ctx.sessions.binding(id)` and the ordinary Session-scoped standard props resolve without changing `sessions.list.current`.
- [ ] Explicit rendering of a provisional identity performs no Host history request.
- [ ] Host publication upgrades the same identity and binding to a durable Session; its provisional disposer becomes a no-op for the published row.
- [ ] A Host list refresh preserves an unpublished provisional row; release removes it and its scope exactly once.
- [ ] Explicit rendering of an already published cold Session opens its history/subagent catalog without selecting it.
- [ ] Focused tests cover publication/release races, duplicate staging, refresh, cold open, disposal, and stable binding identity; README/JSDoc and the owning bilingual Agent Note are current.

## Dependencies

Blocked by: #586.

Blocks: #589, #590.
