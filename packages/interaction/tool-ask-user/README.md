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
- `to_project_member` — optional single addressee. When present, the call is routed through `ctx.memberQuestionSender` and never reaches the local user-questions provider. Runtime eligibility hides this parameter from assembled prompts unless `boundProjectResolver` returns a cloud-project id; the static registry schema still retains it.
- `background` — agent-authored Decision Brief text. Required with `to_project_member`; 1 to 600 Unicode code points, rejected at construction with `BACKGROUND_REQUIRED` or `BACKGROUND_TOO_LONG`.
- `references` — optional `{ path, reason? }[]` available for local and routed asks. Each `path` must resolve to an existing file inside the asking session workspace; each `reason` is at most 100 code points. Failures throw `REFERENCES_INVALID` naming the failing items. Local asks accept references without changing routing; focusing the details panel on a referenced file is deferred.

Without `to_project_member` the tool calls `ctx.userQuestions.ask()` and returns canonical `{ answers: [{ id, selected, custom? }] }`. `selected` contains option labels; `custom` carries a free-form answer, supplementing `selected` for a multi-select question and overriding it for a single-select question. The Native renderer preserves the compact JSON text shape `{ "answers": [{ "id": "...", "selected": ["..."], "custom": "..." }] }`. A routed ask requires a `routeResolver` that derives the bound Project and authenticated origin from a current roster containing the addressee; public login matching is case-insensitive. An absent member fails with `INELIGIBLE_ADDRESSEE` before delivery, while a missing sender or resolver fails with `SENDER_UNAVAILABLE`. Tool cancellation propagates through the route resolver. Sender lifetime failures (`MEMBER_OFFLINE`, `QUESTION_EXPIRED`, `QUESTION_WITHDRAWN`, `QUESTION_SUPERSEDED`, `REVOKED_DURING_FLIGHT`) remain ordinary tool results.

## Role

This is the Consumer package for the user-questions seam and the member-question sender seam. It does not render UI and does not know how input is collected; local asks translate model arguments into `AskUserQuestionRequest`, and routed asks forward a validated payload to `ctx.memberQuestionSender.send()`.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`ask_user_question` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ask-user), including question ids, prompts, headings, options, multi-select flags, `background`, and `references`. `to_project_member` is present only when the asking workspace is bound to a cloud project.

#### Token effect

Standing schema cost on every request where the tool is visible: `background` and `references` remain in the assembled schema. `to_project_member` adds a further schema cost only when `boundProjectResolver` returns a cloud-project id; unbound assemblies omit that property and keep the previous schema width.

#### KV Cache effect

Prefix-stable while the definition and the bound-project visibility of `to_project_member` are unchanged. Binding or unbinding the workspace, plugin lifecycle, or scoped restrictions change the assembled schema and invalidate reuse from this prefix.

### Tool-call history and result

#### What the model sees

The model's full questions remain in the assistant tool-call arguments. A routed ask also retains `to_project_member`, `background`, and `references` there. After the human or member answers, the next step sees compact JSON in the exact shape `{"answers":[{"id":"<id>","selected":["<label>"],"custom":"<text>"}]}`; `custom` is omitted when unused and `selected` can contain zero, one, or several labels. Sender lifetime errors return as ordinary tool-result text. UI interaction while the call is pending is not model context.

#### Token effect

Arguments, `background`, `references`, answer JSON, and lifetime-error text are data-dependent retained tokens; there is no token cost while waiting for the human or the member.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **A pending question blocks the tool call until the human answers** — the tool declares no `timeout-policy` budget; cancellation rides the turn's `exec.signal` only.
- **Runtime-owned subagents cannot ask the user** — `ask_user_question` rejects a live child owned by another agent with `DELEGATED_CALLER`; the child must include the unresolved question or decision in its final result. Durable lineage does not decide this boundary, so a lineage-bearing session resumed as a runtime root may ask normally.
- **Native answers render as JSON text** — the canonical value remains structured, but the model-facing result uses compact JSON rather than a richer content-block vocabulary.
- **`to_project_member` stays in the static schema** — prompt assembly omits it for unbound workspaces by filtering the assembled tool list; `ctx.tools.schemas()` and the generated catalog still record the static parameter.
- **Local reference focusing is deferred** — `references` is accepted and validated for local asks, but opening the details panel on a referenced file lands with a later ticket.
- **Routed delivery rides the T4 registry-transport gap** — encoding and the sender interface exist; opening a sealed peer grant on the addressee's installation and carrying it across machines remain the [Remote Access Known Limitation](../../platform/remote-access/README.md#known-limitations-and-deferred-work). Until that transport lands, a composition without a delivery adapter fails closed with `SENDER_UNAVAILABLE` or `DELIVERY_UNAVAILABLE` rather than queuing.
- **Routed references load workspace bytes for `document-chunk` transfer** — local asks still validate path metadata only. A routed ask reads each admitted file and forwards aligned `{ path, bytes }` to the sender, which encodes Companion `document-chunk` frames; receiver reassembly remains a consumer duty.
