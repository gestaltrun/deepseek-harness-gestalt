# Agent Note: Enable model invocation for the Matt delivery skill batch

Status: implemented

English | [中文](2026-08-27-enable-matt-delivery-skills-model-invocation.zh.md)

## Problem

Orchestrated ticket writers run as fresh subagents that must execute the delivery workflow themselves, but `implement`, `to-spec`, and `to-tickets` carried `disable-model-invocation: true`, so a writer could neither invoke nor formally enter the workflow it was contracted to follow; instructions degraded to free-form imitation of the skill text.

## Decision

The `implement`, `to-spec`, and `to-tickets` skills are model-invoked in both supported products. Their `SKILL.md` files omit `disable-model-invocation`, and their Codex `agents/openai.yaml` files set `policy.allow_implicit_invocation: true`. Writers self-invoke the workflow and its `/tdd` and `/code-review` steps; repository overrides (`dsh-pre-push-checks`, testing policy) keep pruning the generic full-suite advice. `tdd` and `code-review` remain model-invoked.

## Verification

- `verify-skill-invocation-metadata` requires the Claude Code and Codex policies to agree for every skill carrying Codex metadata.
- The skill validators parse the three skill entrypoints and Codex metadata files.

## Consequences

The three descriptions remain in the model's discovery context so router and delivery workflows can invoke them without copying their bodies into handoffs. The invocation metadata check rejects product-specific drift. Skills outside this batch retain their existing invocation policy.

## Alternatives considered

**Strip the flag from all 22 flagged skills** — rejected because the other nineteen (grilling variants, handoff, teach, retro, writing-craft) are deliberate human-invoked surfaces with no role in ticket delivery; widening them changes product behavior nobody requested.

**Keep the flag and have the root task paste workflow text into every handoff** — this shipped first as an ad-hoc amendment; rejected as durable practice because it forks authority between the tracked skill file and per-handoff prose that drifts silently.
