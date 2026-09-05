# Agent Note: Evidence-based delegation guidance

Status: implemented

English | [中文](2026-09-05-evidence-based-delegation-guidance.zh.md)

## Problem

Repository workflows delegated work without one shared rule for selecting a task-appropriate model or deciding whether a continuable child retained useful context. Some instructions relied on implicit parent routing, while generic skills could require user-only entry points or impose terminology, layouts, hooks, and test breadth that conflict with repository owners. Root and Web-client instructions also carried conditional procedures without reliable discovery from every applicable directory.

## Decision

[`docs/agents/delegation-routing.md`](../../../../docs/agents/delegation-routing.md) is the provider-neutral owner for delegation routing and child-context reuse. Dispatchers choose an explicit available provider and model under current user restrictions, separate configured capability and official product claims from repository task evidence, and accept work only through observable checks. The reference maps deterministic work to direct tools and defines conditional tiers for extraction, routine edits, backend implementation, long autonomous work, broad synthesis, visual work, and high-risk architecture or review.

Dispatchers inspect direct continuable children before starting a new child. Related follow-up may continue a child whose evidence, model, scope, and permissions remain suitable. Independent review, a model change, stale assumptions, or unrelated work starts fresh. Forking is reserved for tasks that genuinely require completed parent history. A delta brief carries only changed facts and completion evidence. Continuation does not change the fixed route, redirect a running turn, expose all workspace history, or guarantee provider-side KV cache.

[`docs/agents/delegation-routing-cliproxyapi.md`](../../../../docs/agents/delegation-routing-cliproxyapi.md) is an optional installation profile. It preserves exact locally working ids and capability restrictions without requiring CLIProxyAPI elsewhere. It excludes removed candidates, keeps Astra out of silent fallback, distinguishes text-only GLM-5.3 from visual GLM-5.3-Flash, and records the unknown backend mapping of `gemini-3.8-flash-high`.

Skills consume shared workflows as ordinary references when the target skill is user-invoked. Generic workflows defer to repository terminology, decision records, source layout, hook ownership, and changed-behavior test policy. Code review distinguishes committed-only and work-in-progress modes so staged, unstaged, and untracked work remains visible. Parsed skill-description validation rejects an unquoted YAML comment marker that would truncate hash-bearing descriptions.

Conditional client scaffolding lives in a cookbook reached from the standing client rules, and `apps/web/AGENTS.md` provides the missing discovery pointer. Root instructions link the routing owner and state the unstable-format policy by the format owner's compatibility declaration rather than repository tag presence. GitHub runner details defer to live workflow expressions.

## Alternatives considered

**Embed model ids in root instructions.** Rejected because every session would pay the context cost and installations without CLIProxyAPI would receive unusable policy. The root carries one conditional pointer; the provider mapping remains optional.

**Implement a runtime model router or inspect user settings automatically.** Rejected because this change governs contributor workflows, not product routing or credentials. Available tools and deployment catalogs remain runtime facts, and user restrictions remain authoritative.

**Always start fresh or always continue.** Rejected because independent review and route changes require fresh context, while related fixes can reuse valuable evidence. The decision depends on scope, evidence currency, model fit, permissions, and independence rather than an arbitrary token threshold.

**Copy generic engineering templates into repository policy.** Rejected because project Agent Notes, terminology, source layout, hooks, and tests are the authoritative owners. Generic skills remain reusable by deferring to those owners.

## Consequences

Delegation has one discoverable provider-neutral policy and an optional concrete profile. Dispatch briefs become smaller, route choices are explicit when supported, and follow-up reuse preserves useful evidence without weakening independent review. Model capability and cost claims stay bounded to their sources.

Instruction context shrinks where conditional client scaffolding moves behind a cookbook pointer, while safety, credentials, lifecycle, testing, release, and logging obligations remain in standing owners. Documentation-only workflow guidance does not alter assembled product or model-visible runtime output, so no keyless runtime snapshot changes; focused script tests pin the parsed-description regression, and documentation gates pin links, pairing, format, and budgets.

The policy still relies on dispatcher judgment and accumulated task evidence. It does not provide cross-parent child adoption, arbitrary session-history search, effort selection, cache telemetry, billing data, or a universal model ranking.