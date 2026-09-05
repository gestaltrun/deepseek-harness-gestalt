# Delegation routing and context reuse

English | [中文](delegation-routing.zh.md)

Use this reference before dispatching or continuing a subagent. It governs task-to-model selection and child-context reuse without requiring any particular provider.

## Decide whether to delegate

Use deterministic tools directly for file discovery, status, exact transformations, and small local checks. Delegate when a bounded independent task benefits from separate context, parallel work, a different model, or an isolated review. Keep one mutable writer per worktree; read-only investigation and review may run in parallel.

Define the deliverable, read/write scope, risk, acceptance evidence, required context, and independence before choosing a route. Source code and observable checks—not a model's confidence—decide acceptance.

## Select a model explicitly

Choose an available provider and model for the task, current user restrictions, verified input capabilities, and measured performance on comparable repository work. Pass both route fields when the runtime supports them instead of inheriting the parent route by omission. Distinguish three evidence levels:

1. **Configured capability** says what the current adapter exposes.
2. **Official source claim** supports product tier or input capability, not a universal ranking.
3. **Task evidence** records whether the route produced accurate, checkable work in this repository.

Use this default mapping only when the named tier or a measured equivalent is available:

| Task | Default tier |
| --- | --- |
| Deterministic lookup or conversion | Direct tools |
| Simple bulk extraction or classification | Luna-class high-throughput model |
| Bounded routine edits and test additions | Terra-class or GLM Flash-class model |
| General backend and terminal implementation | GLM-class engineering model |
| Long autonomous implementation | Grok- or Kimi-class long-horizon model |
| Broad evidence integration across many sources | Kimi-class long-context model |
| Frontend implementation or visual verification | Gemini-class or visual GLM Flash-class model |
| Architecture, cross-package lifecycle or security work, difficult root cause, or independent high-risk review | Sol-class or a proven equivalent |

A model name does not establish input support. Route screenshots only through a model and adapter verified to accept images; text-only models stay on text tasks. Media-generation models are not text coding agents. Respect excluded models and providers; do not silently fall back to them. Published list prices describe vendor tiers, not an intermediary account's bill. Do not invent unsupported effort arguments, cache guarantees, or benchmark rankings.

An installation-specific mapping may supplement this reference. [The optional CLIProxyAPI profile](delegation-routing-cliproxyapi.md) records one such mapping and is not required for other installations.

## Reuse or start fresh

Before creating a child, inspect relevant direct continuable children when the runtime provides that catalog.

**Continue a direct child** for a related follow-up when its evidence remains current, its fixed model still fits, its scope and permissions still fit, and independence is unnecessary. Send a delta brief: the new objective, current base, changed files or invalidated facts, retained constraints, and completion evidence. A follow-up message schedules the child's next turn; it does not change the route or redirect work already running.

**Start a fresh child** for independent review, a model change, stale or systematically incorrect assumptions, unrelated work, or a task whose concise handoff costs less than repairing old context.

**Fork the parent** only when the task genuinely requires decisions spread across completed parent turns and a concise brief would lose necessary context. A fork is not an independent review and does not imply provider-side cache reuse.

The child catalog is not all workspace history. Only direct continuable children are follow-up targets; do not adopt children across parents or inspect private session storage to manufacture continuity. Persist durable decisions in repository owners such as specifications, Context documents, and Agent Notes.

## Dispatch brief and acceptance

Use a minimal task packet:

- deliverable and observable completion evidence;
- necessary issue, specification, files, and current commit or worktree delta;
- read/write scope and explicit exclusions;
- required distinctions between confirmed facts, hypotheses, and unknowns;
- expected findings, checks actually run, and unresolved limitations.

Reuse saves reconstruction only when the retained evidence outweighs stale context, correction cost, queue delay, and bias. Do not use arbitrary token thresholds or claim persistent KV cache. If a route repeatedly violates evidence or tool requirements, narrow once with explicit correction, then start fresh on a better-fitting route.