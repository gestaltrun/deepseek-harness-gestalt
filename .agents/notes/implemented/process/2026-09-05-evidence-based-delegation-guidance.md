# Agent Note: Evidence-based delegation guidance

Status: implemented

English | [中文](2026-09-05-evidence-based-delegation-guidance.zh.md)

## Problem

Repository workflows delegated work without one shared rule for selecting a task-appropriate model or deciding whether a continuable child retained useful context. Some instructions relied on implicit parent routing, while generic skills could require user-only entry points or impose terminology, layouts, hooks, and test breadth that conflict with repository owners. Root and Web-client instructions also carried conditional procedures without reliable discovery from every applicable directory.

## Decision

[`docs/agents/delegation-routing.md`](../../../../docs/agents/delegation-routing.md) is the provider-neutral owner for delegation routing and child-context reuse. Dispatchers choose an explicit available provider and model under current user restrictions, separate configured capability and official product claims from repository task evidence, and accept work only through observable checks. The reference maps deterministic work to direct tools and defines conditional tiers for extraction, routine edits, backend implementation, long autonomous work, broad synthesis, visual work, and high-risk architecture or review.

Dispatchers inspect direct continuable children before starting a new child. Related follow-up may continue a child whose evidence, model, scope, and permissions remain suitable. Independent review, a model change, stale assumptions, or unrelated work starts fresh. Forking is reserved for tasks that genuinely require completed parent history. A delta brief carries only changed facts and completion evidence. Continuation does not change the fixed route, redirect a running turn, expose all workspace history, or guarantee provider-side KV cache.

While a writer runs, the coordinator merges its feedback into one versioned fix list delivered at a natural checkpoint instead of scattering follow-up messages that queue behind the running turn and burn acknowledgement rounds; an immediate safety stop still interrupts. Without a new commit, failure, or completion event, the coordinator does not re-poll `list_agents`, git, or CI and relies on completion notifications, re-verifying state only after a change. These supervision rules are ordinary prose in the routing reference; no tool or runtime change carries them.

[`docs/agents/delegation-routing-cliproxyapi.md`](../../../../docs/agents/delegation-routing-cliproxyapi.md) is an optional installation profile. It preserves exact locally working ids and capability restrictions without requiring CLIProxyAPI elsewhere. It excludes removed candidates, keeps Astra out of silent fallback, distinguishes text-only GLM-5.3 from visual GLM-5.3-Flash, and records the unknown backend mapping of `gemini-3.8-flash-high`.

Skills consume shared workflows as ordinary references when the target skill is user-invoked. Generic workflows defer to repository terminology, decision records, source layout, hook ownership, and changed-behavior test policy. Code review distinguishes committed-only and work-in-progress modes so staged, unstaged, and untracked work remains visible. YAML retains its standard plain-scalar semantics: an unquoted ` #` begins a comment. Hash-bearing skill descriptions therefore use quoting or a block scalar, and the focused metadata regression proves the resulting parsed catalog description retains the complete trigger; the parser does not preserve invalidly authored plain-scalar text.

Conditional client scaffolding lives in a cookbook reached from the standing client rules, and `apps/web/AGENTS.md` provides the missing discovery pointer. The cookbook retains the registration-failure facts: each of the three registration surfaces fails at a different later point when missing, and a bare profile row resolves only through the healed `$DSH_HOME/profiles/node_modules` fallback, so a package no app or bundle manifest declares fails to import. Root instructions link the routing owner, define the user-visible language precedence for subagent descriptions and todo content without changing identifiers or internal prompts, and state the unstable-format policy by the format owner's compatibility declaration rather than repository tag presence. Tag creation and GitHub Releases stay behind explicit per-release approval. GitHub runner details defer to live workflow expressions.

The session retrospective rules live in [`docs/agents/session-retro.md`](../../../../docs/agents/session-retro.md) as an ordinary shared reference. The `retro` skill remains the user-invoked entry and the delivery workflow links the shared standard, so a coordinator can request each writer's own-session retrospective without requiring a user-only skill through an automatic call. Candidates cover only the session running them, read no other session's logs, and reach the user's explicit keep-or-drop gate before anything lands. Every changed file ends with exactly one trailing newline; the focused checks re-verify it byte-wise because the staged-diff whitespace gate cannot catch a missing final newline on a wholly new file.

## Alternatives considered

**Embed model ids in root instructions.** Rejected because every session would pay the context cost and installations without CLIProxyAPI would receive unusable policy. The root carries one conditional pointer; the provider mapping remains optional.

**Implement a runtime model router or inspect user settings automatically.** Rejected because this change governs contributor workflows, not product routing or credentials. Available tools and deployment catalogs remain runtime facts, and user restrictions remain authoritative.

**Always start fresh or always continue.** Rejected because independent review and route changes require fresh context, while related fixes can reuse valuable evidence. The decision depends on scope, evidence currency, model fit, permissions, and independence rather than an arbitrary token threshold.

**Copy generic engineering templates into repository policy.** Rejected because project Agent Notes, terminology, source layout, hooks, and tests are the authoritative owners. Generic skills remain reusable by deferring to those owners.

## Consequences

Delegation has one discoverable provider-neutral policy and an optional concrete profile. Dispatch briefs become smaller, route choices are explicit when supported, and follow-up reuse preserves useful evidence without weakening independent review. Model capability and cost claims stay bounded to their sources.

Instruction context shrinks where conditional client scaffolding moves behind a cookbook pointer, while safety, credentials, lifecycle, testing, release, and logging obligations remain in standing owners. Documentation-only workflow guidance does not alter assembled product or model-visible runtime output, so no keyless runtime snapshot changes; focused script tests pin the parsed-description regression, and documentation gates pin links, pairing, format, and budgets.

The policy still relies on dispatcher judgment and accumulated task evidence. It does not provide cross-parent child adoption, arbitrary session-history search, effort selection, cache telemetry, billing data, or a universal model ranking. Delivery still requires the exact pull-request head to pass `all checks passed`, followed by a merge-queue candidate that passes `candidate verdict`; neither check substitutes for the other.
