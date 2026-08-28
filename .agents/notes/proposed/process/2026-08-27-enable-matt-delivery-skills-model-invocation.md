# Agent Note: Enable model invocation for the Matt delivery skill batch

Status: proposed

English | [中文](2026-08-27-enable-matt-delivery-skills-model-invocation.zh.md)

## Problem

Orchestrated ticket writers run as fresh subagents that must execute the delivery workflow themselves, but `implement`, `to-spec`, and `to-tickets` carried `disable-model-invocation: true`, so a writer could neither invoke nor formally enter the workflow it was contracted to follow; instructions degraded to free-form imitation of the skill text.

## Proposal

Remove the flag from exactly `.agents/skills/{implement,to-spec,to-tickets}/SKILL.md`. Writers self-invoke the workflow and its `/tdd` and `/code-review` steps; repository overrides (`dsh-pre-push-checks`, testing policy) keep pruning the generic full-suite advice. `tdd` and `code-review` were already model-invocable and stay unchanged.

## Acceptance criteria

- The three named `SKILL.md` files contain no `disable-model-invocation` frontmatter.
- A dispatched ticket writer can enter the implement workflow without the root task pasting its body into the handoff.
- Skills outside the named trio keep their previous invocation policy.

## Risks

An upstream sync that restores the flag silently would send writers back to imitation; the delivery contract must fail at dispatch if the flag reappears, and restoring the deletion belongs in that sync's local-modification log. Widening the change to the other nineteen flagged skills would expose human-owned chat surfaces to model invocation without a product request.

## Alternatives considered

**Strip the flag from all 22 flagged skills** — rejected because the other nineteen (grilling variants, handoff, teach, retro, writing-craft) are deliberate human-invoked surfaces with no role in ticket delivery; widening them changes product behavior nobody requested.

**Keep the flag and have the root task paste workflow text into every handoff** — this shipped first as an ad-hoc amendment; rejected as durable practice because it forks authority between the tracked skill file and per-handoff prose that drifts silently.
