## Parent

Part of #{{PARENT}}.

## Starting point

Start from the remote upstream-sync baseline after #{{T1}} merges.

## Outcome

Restore Gestalt deferred tool discovery and eligibility on upstream Tools interfaces, migrate ACP consumers to the current SDK, and combine deployment-preauthorized child routes with upstream per-Session subagent authorization.

## What to build

- Restore the live fork behavior represented by deferred tool search/loading, eligibility contributions, allowed catalogs, and Agent-loop dispatch without restoring obsolete barrel exports or parallel registries.
- Keep eligibility enforcement in the operation that executes or exposes a tool. Preserve model-visible schemas and durable discovery results.
- Implement the approved D1 policy: upstream user/session route authorization remains authoritative; an injected deployment-owned route set is unioned in memory when a new top-level Session snapshots policy. Startup must not write or revise the user's settings document.
- Reject unauthorized child routes before provider execution. Resolve and preflight provider/model pairs through the upstream LLM registry. Preserve parent-route inheritance when no explicit route is requested.
- Restore the fork's supported child images and agentOptions capability in the upstream Subagent request types, then remove merge-residue duplicate object properties.
- Migrate `dsh-acp`, `dsh-subagent-acp`, session-snapshot support, and relevant CLI tests to the current `@agentclientprotocol/sdk` `Agent`/`Client` interfaces; do not add compatibility exports for removed SDK names.

## File ownership

Own `packages/core/tools/**`, `packages/core/tools-eligibility/**`, `packages/core/agent-tool-eligibility/**`, the Tools portions of `packages/core/agent-loop/**`, `packages/subagent/**`, `packages/acp/acp/**`, and directly related focused tests/examples. Do not edit controllers, Member Question packages, Agent Teams, root lock/config files, or Client rendering packages.

## Non-goals

- No controller Remote exposure for tool eligibility; #590 owns it.
- No Member Question or Side Chat behavior.
- No global unrestricted subagent model-selection mode.

## Acceptance criteria

- [ ] Deferred discovery returns only currently eligible tools, records returned schemas durably, and rejects stale/ineligible schemas before later prompt reconstruction.
- [ ] Tool execution cannot bypass eligibility through a direct or deferred path.
- [ ] A deployment-preauthorized route is available to the model and spawns successfully without mutating settings.
- [ ] A route absent from both user and deployment authorization fails before child creation with a stable model-visible diagnostic.
- [ ] Session policy replay/resume retains the exact authorized route set.
- [ ] ACP and every in-scope Subagent provider compile and pass focused lifecycle/cancellation tests on the current SDK.
- [ ] Required keyless real-composition snapshot, Agent Note, README, JSDoc, and both SDK expected-output changes land where applicable.

## Evidence

Focused Tools, eligibility, Agent-loop, Subagent, ACP, continuation, and snapshot checks selected through `dsh-pre-push-checks`.

## Dependencies

Blocked by: #{{T1}}.
