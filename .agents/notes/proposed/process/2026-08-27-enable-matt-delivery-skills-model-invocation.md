# Agent Note: Enable model invocation for the Matt delivery skill batch

Status: proposed

English | [中文](2026-08-27-enable-matt-delivery-skills-model-invocation.zh.md)
## Problem

Orchestrated ticket writers run as fresh subagents that must execute the delivery workflow themselves, but `implement`, `to-spec`, and `to-tickets` carried `disable-model-invocation: true`, so a writer could neither invoke nor formally enter the workflow it was contracted to follow; instructions degraded to free-form imitation of the skill text.

## Proposal

Remove the flag from exactly `.agents/skills/{implement,to-spec,to-tickets}/SKILL.md`. Writers self-invoke the workflow and its `/tdd` and `/code-review` steps; repository overrides (`dsh-pre-push-checks`, testing policy) keep pruning the generic full-suite advice. `tdd` and `code-review` were already model-invocable and are unchanged.

## Alternatives considered

**Strip the flag from all 22 flagged skills** — rejected because the other nineteen (grilling variants, handoff, teach, retro, writing-craft) are deliberate human-invoked surfaces with no role in ticket delivery; widening them changes product behavior nobody requested.

**Keep the flag and have the root task paste workflow text into every handoff** — this shipped first as an ad-hoc amendment; rejected as durable practice because it forks authority between the tracked skill file and per-handoff prose that drifts silently.

## Acceptance criteria

Dispatched writers confirm the workflow entry before implementation on their next ticket, and no behavior change is possible for skills outside the named trio.

## Risks

If an upstream sync re-introduces the flag, the delivery contract fails loudly at dispatch instead of quietly regressing to imitation; restoring the deletion becomes part of that sync's local-modification log.
