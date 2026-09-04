## Parent

Part of #{{PARENT}}.

## Starting point

Start from the remote upstream-sync baseline after #{{T1}} merges.

## Outcome

Place Gestalt Member Questions on the upstream user-question waterfall, preserve downstream log portability, and make current Agent Teams projections read persisted v1 records.

## What to build

- Preserve upstream Session and projection interfaces; migrate fork consumers away from the removed public `session.events` property to the authoritative snapshot/projection interfaces.
- Extend `AskUserQuestionRequestEvent` with the minimal member-routing input owned by the asker. Keep the accepted Decision Brief presentation intent for the receiving UI.
- Route both local and member-directed asks through `ctx.userQuestions.ask()`. Register the Member Question sender as a Host waterfall answerer: non-member requests call `next()`, member routes are claimed before the remote UI answerer, and no tool directly imports or invokes the sender implementation.
- Preserve sender supersession, delivery, cancellation, expiry, outcome logging, receiver materialization inputs, references, and stable failures from Spec #338.
- Mark `member-question/asked`, `member-question/outcome`, `browser/workspace`, and `session/attachment-admitted` writes as `ignorable: true` at their final owning write points. Do not mark model-history events ignorable.
- Adopt upstream Agent Teams v2 records and decode persisted v1 records into the v2 in-memory representation. The same event names must not cause v1 logs to reach a v2-only projection unchecked.

## File ownership

Own `packages/core/session/**` only for the downstream-event intent and multi-version read contract, `packages/session/session-projection/**` as required by that contract, `packages/interaction/**`, `packages/experimental/agent-team/**`, `packages/experimental/agent-team-profile/**`, `packages/experimental/tool-agent-team/**`, and `packages/experimental/agent-team-web-profile/**`. Do not edit ApiProxy/controllers/remotes, Client UI packages, root configs, or Browser Workspace writer files; record required writer changes for their owning tickets.

## Non-goals

- No Member Question controller/Remote transport port; #590 owns it.
- No receiving UI or Desktop product migration; #591 owns it.
- No legacy `Session.events` compatibility getter.

## Acceptance criteria

- [ ] Every waterfall listener delegates with `next()` unless it deliberately claims the request.
- [ ] Local asks still reach the ordinary UI answerer; member routes reach the sender and never create a local composer card on the asking installation.
- [ ] BAD_INTENT validation accepts the Member Question presentation while retaining plan-review validation.
- [ ] Sender/receiver behavior required by #338, #516, #517, and #520 remains representable through the new interface.
- [ ] A build without Gestalt plugins opens and round-trips logs containing the four fork-only informational events.
- [ ] The merged build folds v1 and v2 Agent Teams fixtures into equivalent current state and writes only v2 records.
- [ ] Focused invariants, keyless real composition, recorded-session snapshot, Agent Note, README/JSDoc, and persistence catalog updates land.

## Dependencies

Blocked by: #{{T1}}.
