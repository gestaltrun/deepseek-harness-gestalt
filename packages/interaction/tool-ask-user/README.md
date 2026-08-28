# @deepseek-ai/dsh-tool-ask-user

English | [中文](README.zh.md)

Model-facing `ask_user_question` tool over `ctx.userQuestions`. It lets the model ask the human a concise question when it needs confirmation, a choice, or missing information before continuing.

## Tool

`ask_user_question` accepts:

- `questions` — required non-empty array of question objects.
- `id` — required stable id on each question, echoed in the answer.
- `question` — required question text for each question.
- `header` — optional short heading.
- `options` — optional choices with `label` and `description`. If recommending a choice, put it first and append `(Recommended)` to that label.
- `multi_select` — whether that question may return more than one selected option.
- `to_project_member` — optional single addressee. When present, the call is routed through `ctx.memberQuestionSender` and never reaches the local user-questions provider. Runtime eligibility filtering of this parameter is deferred.
- `background` — agent-authored Decision Brief text. Required with `to_project_member`; 1 to 600 Unicode code points, rejected at construction with `BACKGROUND_REQUIRED` or `BACKGROUND_TOO_LONG`.
- `references` — optional `{ path, reason? }[]` available for local and routed asks. Each `path` must resolve to an existing file inside the asking session workspace; each `reason` is at most 100 code points. Failures throw `REFERENCES_INVALID` naming the failing items. Local asks accept references without changing routing; focusing the details panel on a referenced file is deferred.

Without `to_project_member` the tool calls `ctx.userQuestions.ask()` and returns canonical `{ answers: [{ id, selected, custom? }] }`. `selected` contains option labels; `custom` carries a free-form answer, supplementing `selected` for a multi-select question and overriding it for a single-select question. The Native renderer preserves the compact JSON text shape `{ "answers": [{ "id": "...", "selected": ["..."], "custom": "..." }] }`. A routed ask that cannot reach a composed sender fails with `SENDER_UNAVAILABLE`.

## Role

This is the Consumer package for the user-questions seam and the member-question sender seam. It does not render UI and does not know how input is collected; local asks translate model arguments into `AskUserQuestionRequest`, and routed asks forward a validated payload to `ctx.memberQuestionSender.send()`.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`ask_user_question` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ask-user), including question ids, prompts, headings, options, multi-select flags, `to_project_member`, `background`, and `references`.

#### Token effect

Fixed schema cost on every request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

The model's full questions remain in the assistant tool-call arguments. After the human answers, the next step sees compact JSON in the exact shape `{"answers":[{"id":"<id>","selected":["<label>"],"custom":"<text>"}]}`; `custom` is omitted when unused and `selected` can contain zero, one, or several labels. UI interaction while the call is pending is not model context.

#### Token effect

Arguments and answer JSON are data-dependent retained tokens; there is no token cost while waiting for the human.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **A pending question blocks the tool call until the human answers** — the tool declares no `timeout-policy` budget; cancellation rides the turn's `exec.signal` only.
- **Runtime-owned subagents cannot ask the user** — `ask_user_question` rejects a live child owned by another agent with `DELEGATED_CALLER`; the child must include the unresolved question or decision in its final result. Durable lineage does not decide this boundary, so a lineage-bearing session resumed as a runtime root may ask normally.
- **Native answers render as JSON text** — the canonical value remains structured, but the model-facing result uses compact JSON rather than a richer content-block vocabulary.
- **`to_project_member` stays in the static schema** — runtime eligibility filtering that hides it from unbound workspaces is deferred; the tool routes only when the argument is present.
- **Local reference focusing is deferred** — `references` is accepted and validated for local asks, but opening the details panel on a referenced file lands with a later ticket.
