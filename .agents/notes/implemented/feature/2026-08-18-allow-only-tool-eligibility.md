# Agent Note: Allow-only tool eligibility

Status: implemented

English | [中文](2026-08-18-allow-only-tool-eligibility.zh.md)

## Problem

An agent preset can compose a tool catalog, but users also need Workspace- and Session-specific additions. The existing `ctx.tools.restrict()` primitive accepts both allow and deny filters and exists for trusted internal composition. Projecting that primitive directly into user settings would create two policy vocabularies, make later registrations behave differently under allow and deny, and contradict the product's positive configuration.

Eligibility must also remain one fact across model assembly and execution. Filtering only request schemas would let a stale or forged call execute, while filtering only dispatch would advertise tools the model cannot use. Persisting only the configured names would still be insufficient for replay because dynamic registration decides which schemas existed for a particular request.

## Decision

`dsh-tools` owns a positive eligibility contribution per scope. Contributions along the preset-to-Agent scope chain union. No contribution preserves the existing unrestricted catalog; a declared chain whose union is empty allows no end tool. Once active, the same resolved view filters inherited and scope-local definitions for `schemas()`, `get()`, and `execute()`. Names are not validated when declared, so a preset or setting may precede dynamic tool registration. The internal allow/deny `restrict()` surface remains available to trusted plugins and is absent from user configuration.

`dsh-agent-tool-eligibility` is the preset row and exposes one required `allow` list. `dsh-tools-eligibility` registers the allow-only `tool-eligibility` settings section with `workspaces` and `sessions` maps. It contributes the matching Workspace and Session lists through one mutable entry per live Agent, owned by the resolver fiber. Every refresh commits all affected entries before fan-out, then attempts the relationship publication and registry change notification for every affected Agent. Ordinary live Settings updates propagate one `AggregateError` after the complete fan-out. Settings provider detach or HMR commits the composition fallback and attempts the same full fan-out, but logs the aggregate so provider unload completes. Observers therefore see one fully committed Agent set, never an old-plus-new entry or a partially refreshed set. Resolver unload and Agent disposal remove the exact entry. Workspace matching uses the stable Workspace id after locating the Workspace whose canonical path equals `session.header.cwd`.

The resolved tool view is the sole runtime authority. Agent-loop request assembly takes schemas from it, and `session.toolEligibility` reads it directly. Execution creation rejects a registered definition already excluded by eligibility before policy. Dispatch rechecks eligibility after pre-policy and before around-dispatch wrappers. Either eligibility denial is terminal: no around-dispatch wrapper, tool body, post-execute listener, or captured definition finalizer runs, while the canonical `UNKNOWN_TOOL` result still reaches `tools/result` and the loop's durable `tool/result`. Unknown or not-yet-loaded names retain their ordinary wrapper path. The resolver's runtime surface is limited to the settings-to-registry lifecycle and does not publish a separate resolution service. The resolver emits a non-durable relationship publication after each settings contribution commit so its invariant companion can compare the expected union with the live registry. The exact model-visible schemas remain reconstructable from the durable `request/header` event, which records every assembled request's tools; no durable eligibility event duplicates that result.

PTC mode keeps `run_code` as reserved presentation infrastructure. Positive eligibility filters the end-tool definitions used to generate its SDK; the transport is not a separately configurable capability.

## Verification

Tool registry tests cover scope-chain union, explicit allow-none, inherited and scope-local schema filtering, rejection before around-dispatch short circuits, terminal eligibility narrowing during pre-policy, unknown-name wrapper compatibility, body and finalizer non-execution, canonical result notification, and staged contribution notification. Agent-loop coverage proves the late denial also skips post-execute and persists the canonical `UNKNOWN_TOOL` result. Resolver tests cover preset, Workspace, and Session additions; two-Agent batch visibility and complete notification fan-out under publication or registry observer failure; resolver unload/HMR; Agent disposal; dynamic registration; and absence of a user-facing deny field. The invariant negative control rejects a publication that differs from the live registry. API tests cover the direct `ctx.tools` projection in `session.toolEligibility`. The Web minimal-preset keyless replay gives the preset an empty allowance, adds `bash` through the real Session settings namespace in the Loader composition, records only `bash` in the durable request header, executes it, and proves a stale `str_replace_editor` call fails before execution.

## Alternatives considered

**Expose `restrict()` as settings.** Rejected because deny is an internal composition mechanism, while the accepted user configuration is positive-only.

**Compile eligibility into an internal restriction per Agent.** Rejected because internal restrictions deliberately exempt scope-local registrations used by delegation machinery. Eligibility must judge every model-visible end tool, including definitions registered in the Agent's own scope.

**Add a durable eligibility event.** Rejected because `request/header.tools` already records the exact model-visible result. A settings event would record an input that may not match the dynamic catalog at request time and would create a second reconstruction source.

## Consequences

Preset authors and users configure only additive allow lists, while the model, Host API, and executor share one catalog. Existing compositions that declare no eligibility remain unrestricted. An effective empty union intentionally removes every end tool, and a misspelled or currently absent name grants nothing until a tool with that exact name registers. Settings documents key entries by stable ids, so a generic settings editor needs those ids; richer Workspace and Session affordances can write the same namespace later without changing the policy model.
