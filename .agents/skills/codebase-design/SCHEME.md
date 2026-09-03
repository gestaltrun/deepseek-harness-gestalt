# Draw and review a technical scheme

A scheme answers **where the seam goes and what the interface hides**. It is not a UI draft and not an implementation ticket.

Two artifacts, never one file doing both jobs:

| Artifact | Audience | Lifetime | Location |
|---|---|---|---|
| Proposed [Agent Note](../../notes/README.md) | Agents and later PRs | Durable until implemented or rejected | `.agents/notes/proposed/` on the planning branch |
| Human review pack | The person who must approve the scheme | One review; disposable | gitignored `.agents/local/scheme-review/<slug>/` |

The Note is the source of truth. The pack is a projection: big pictures, few words, the decision in front. Do not commit the pack. Do not paste the pack into the Note.

## When this is the right work

Use this when the change needs a new module interface, a new seam, cross-package ownership or lifecycle, a durable/wire/config format, or a security or process boundary. Skip it for a UI-only fold-in ([prototype](../prototype/SKILL.md)), a mechanical edit, or a change that already has an implemented Agent Note and does not reverse that decision.

## Session split

Do not write the Note or the pack in the coordinating grill session. Dispatch an isolated Codex worktree task or DSH subagent with a short brief: the product decision already settled, the packages in play, the constraints that must not break.

Wayfinder is not this workflow. Open a map only when one Note cannot hold the remaining decisions. A wayfinder ticket may then say "draw this scheme"; its resolution is the Note plus the pack.

## Process

### 1. Explore

Read the host code, current Agent Notes, consumers, and failure modes. Facts are the agent's job. Do not ask the user for anything a subagent can look up. Stop if a product question is still open; send it back to grilling.

### 2. Write the proposed Agent Note

On the planning branch, add `.agents/notes/proposed/<class>/yyyy-mm-dd-<slug>.md` (and the Chinese pair) with the implemented-note skeleton in proposal tense: Problem, Proposal, Alternatives considered, Acceptance criteria, Risks. Between those headings, add only the technical sections the decision needs: module and interface, lifecycle and ownership, failure modes, verification.

Use the vocabulary in [SKILL.md](SKILL.md). Follow [dsh-prose-standard](../dsh-prose-standard/SKILL.md). Do not list file paths as the scheme. Do not embed the UI high-fidelity draft; link it if a prototype already froze one.

### 3. Self-check the Note

Do not build the pack until every item holds:

- The interface is deep: callers learn little, the module hides much.
- A seam exists only if something actually varies across it (two adapters, or a real second consumer).
- Lifecycle, cancellation, and disposal are written, not implied.
- Each tempting alternative is recorded and lost for a reason.
- Acceptance criteria are observable (test, log, failure state), not "the implementation is correct".
- Product scope matches the grill. No silent extra surface.

### 4. Build the human review pack

Create `.agents/local/scheme-review/<slug>/` (already gitignored under `.agents/local/`). Write one HTML file the user can open. That file is the review, not a dump of the Note.

Compose it with three skills, in this order:

1. **eli5** — one page a newcomer can follow: what exists today, what hurts, what we will hide behind the new interface. Big pictures, few words. No Agent Note headings.
2. **show-me** — the smallest diagram that makes the seam, call tree, or state change obvious. Match Desktop/Settings colors and real names. One focused visual next to the sentence it supports.
3. **unslop** — rewrite the pack as voice-led human prose. Opinions are allowed here. Exact module, seam, and failure names stay. Do not unslop the Agent Note; that file stays contract prose.

The pack must fit on a short scroll:

- The decision in one sentence.
- One before/after or call-tree picture.
- What we give up (the lost alternatives, in plain speech).
- How we will know it worked.
- A link to the proposed Agent Note for agents and later PRs.

No caption inside a diagram that restates the picture. No "in conclusion". No file-path inventory.

### 5. Ask the human to review

Open the HTML. The headed browser or `open` is for looking, not for drawing. Ask for approval, a change, or rejection. Record the verdict on the planning issue or the Note's thread. Leave the pack in `.agents/local/`; do not commit it.

Freeze means: the Note stays `proposed/` until an implementation PR rewrites it to present-tense `implemented/`. Freeze is not merge, and it is not permission to skip `to-spec`.

## After freeze

[`to-spec`](../to-spec/SKILL.md) summarizes Implementation Decisions and links the Note. [`to-tickets`](../to-tickets/SKILL.md) points structural tickets at that Note. Implementation review uses [`dsh-code-review`](../dsh-code-review/SKILL.md) against the same Note; it does not replace this human review of the scheme.
