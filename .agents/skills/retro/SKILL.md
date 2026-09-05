---
name: retro
description: "Conduct a retrospective on a coding session."
disable-model-invocation: true
---

The user has asked for a **retrospective**. You are suggesting improvements to the coding agent's **environment** to improve future runs. The [session retrospective standard](../../../docs/agents/session-retro.md) owns the shared rules: review only the session running this skill, read no other session's logs, and hand candidates to the user's keep-or-drop decision instead of landing them.

## Steps

1. Use [`writing-for-agents`](../writing-for-agents/SKILL.md) for the writing standard.

2. Read the primary sources for the session the user specifies. This may mean searching through session logs on this machine. If the user doesn't specify a session, default to the current one.

3. Look for candidates for improvement in these categories.

- **Navigation**: how easy was it for the agent to find the right files? Are there hidden dependencies between files? Would a **navigation pointer** make it easier? _Use when_ the session took a long time to find a piece of information.
- **Automated checks**: are there automated checks that could catch errors the agent made? Linting, typing, tests, filesystem linters? _Use when_ the agent made a mistake that could have been caught by an automated check.
- **Coding standards**: should the **reviewer agent** be given a new rule to enforce? Should an existing rule be removed or clarified? _Use when_ the reviewer agent failed to catch a mistake.
- **Global AGENTS.md**: are there any steering instructions that should be moved to coding standards (or automated checks) instead? _Use when_ the AGENTS.md file is particularly large - in the repo OR the user's global scope.
- **Tool economy**: did the agent make expensive tool calls that could be streamlined? Is there any custom tooling (CLI's, MCP's) that is particularly token-inefficient? _Use when_ the agent made an expensive tool call.
- **No-ops**: look for instructions in steering files that don't modify the agent's behavior. _Use when_ the steering files are large and unwieldy.
- **Information access**: look for opportunities to increase the agent's access to information. Teeing dev server logs, readonly access to third-party services. _Use when_ a crucial piece of information was not available to the agent.

4. Present these candidates to the user, in order of severity.

## Reference

### Implementation vs Review

Remember that all work goes through two stages: implementation and review. The implementation agent has the most **context pressure**. They are responsible for exploration, writing code, and debugging failures.

The review agent starts from a diff and then reads the surrounding code, contracts, and consumers needed to judge it. It often does not need to write code or debug.

Implementation and review agents both follow the repository standards. Put independent enforcement in review or an automated check when repeating it during implementation would add context without changing implementation decisions.

### Files

You have access to several files in the repo:

- [`AGENTS.md`](../../../AGENTS.md): standing repository instructions loaded for implementation and review. Keep additions short and link to the owning reference.
- [`dsh-code-review`](../dsh-code-review/SKILL.md): review-only checks that need independent judgment.
- [`docs/`](../../../docs/): human-facing references and contributor procedures. Reuse the owning document instead of adding a second explanation.
- [`.agents/skills/`](../): reusable workflows and decision standards. Follow [`writing-for-agents`](../writing-for-agents/SKILL.md) when changing them.
