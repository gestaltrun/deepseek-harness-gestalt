# Session retrospective standard

English | [中文](session-retro.zh.md)

This reference carries the shared rules for a session retrospective: what a writer session reviews, which sources it may read, and how its candidates reach a user decision. The [`retro`](../../.agents/skills/retro/SKILL.md) skill is the user-invoked entry; [the delivery workflow](../../.agents/skills/orchestrate-dsh-delivery/SKILL.md) links this page so a coordinator can ask each writer session to run its own retrospective without requiring that user-only skill through an automatic call.

## Scope

A session retrospective reviews one session: the session running it. Each writer runs its own retrospective on the session that performed its ticket work; a coordinator or another session never runs it on someone else's behalf. Read only the current session's own logs and workspace state. Do not read other sessions' logs, other writers' private session storage, or another user's environment.

## Candidates

Collect improvement candidates from the session's own observable history: navigation friction, mistakes an automated check could have caught, review rules that failed, standing instructions that were no-ops, expensive tool calls, and information that was unavailable at decision time. Order them by severity. A candidate states the observed evidence and the proposed environment change, not a model's confidence or a complaint about task content.

## Decision gate

Candidates never land on their own. The writer reports its candidate list to the requesting coordinator, which synthesizes the collected candidates and presents them to the user for an explicit keep-or-drop decision per item. Only accepted items are landed, through the delivery workflow's merger path, and the affected checks re-run. A delivery does not merge before that decision.

## Reference

- [`retro`](../../.agents/skills/retro/SKILL.md) — the user-invoked retrospective skill that runs this standard on the session the user names, defaulting to the current one.
- [One specification pull request with a retro gate](../../.agents/notes/implemented/process/2026-09-02-spec-pr-delivery-and-retro.md) — the delivery decision that places the retro gate before merge.
