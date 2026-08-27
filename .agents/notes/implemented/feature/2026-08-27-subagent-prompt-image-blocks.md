# Agent Note: Subagent prompt image blocks

Status: implemented

English | [中文](2026-08-27-subagent-prompt-image-blocks.zh.md)

## Problem

The delegation plane had no image path. `tool-subagent`'s schema declared `prompt: string` and its execute hardcoded `[{ type: 'text', text }]`, so a parent model could never hand a picture to a child — neither pasted conversation images nor workspace figures. The LLM vocabulary already carried a role-neutral `ImageBlock` over durable `ImageAttachmentRef`s, and `SubagentStartRequest.prompt` was already `ContentBlock[]`; only the tool layer and backend guarantees were missing. Models cannot retype pixels as base64 and hold no attachment ids, so any solution must move bytes structurally from a reference the model does hold: a workspace file path.

## Decision

`SubagentCapabilities` gains an `images` flag, validated by the service's `assertCapabilities`: a prompt containing an `ImageBlock` on a backend without the flag rejects with `UNSUPPORTED_CAPABILITY`. The tool schema gains an optional `images` array of workspace paths, present only when the bound provider advertises the capability; execute re-checks before any I/O because the validator admits undeclared keys.

Each path resolves through the calling session's filesystem policy and must name a regular PNG, JPEG, WebP, or GIF file. The tool reads the complete ordered batch under the per-image byte cap, then `attachments.saveImages` enforces the message-wide image-count and aggregate-byte limits, validates every member, and commits the batch before delegation starts. Background Job admission finishes before file reads or attachment commits. Foreground and continuable calls commit attachments before provider startup; a later startup failure may leave immutable, content-addressed objects that no child prompt references. The resulting `ImageBlock`s ride `request.prompt` after the text; in-process drivers deliver prompt blocks unchanged as the child's first user message, so the child's own request assembly resolves the durable references.

Only `spawn` and `fork` advertise `images: true`: both run the child in-process against the same attachment store. Out-of-process backends (`acp`, `codex`, `claude-code`, `dsh-sdk` via `NO_START_CAPABILITIES`, plus `subagent-acp`'s inline advertisement) stay `false` until their wire provably preserves image blocks end to end; the schema omits the parameter there and execute rejects it loudly. Fork-seeded children already inherit pasted images through log copying — unchanged.

Whether the child's model route accepts image input is decided at the child's own request assembly, exactly like any other user content; the tool does not pre-judge an unresolvable child route.

## Alternatives considered

**Accept inline base64 in tool arguments.** The model never holds raw bytes; it cannot produce them for pixels it merely saw.

**Reference attachments by id.** Ids never appear in model-visible text, so the model cannot name one.

**Advertise on every backend now.** Each out-of-process wire would need its own end-to-end proof first; silently dropping blocks on an unverified transport is the accepted-then-ignored failure the capability system exists to prevent.

**Extend `send_message` too.** Deferred: continuable follow-ups can cite workspace paths in text until the same channel is proven for later turns. Recorded in the tool README's Known Limitations.

## Consequences

A parent can attach screenshots, diagrams, and figures to a delegation on in-process backends; the child sees the picture itself. The added optional parameter changes the assembled tool schema on capable backends, so the affected keyless snapshot expectations were refreshed in the same change (`DSH_SNAPSHOT=refresh`). The generated tool catalog uses an image-capable fixture and records the conditional filesystem, attachment, and durable-write requirements. Package tests pin the block plumbing, schema gating, pre-I/O rejection, missing-service refusal, and non-image paths; provider suites pin the new capability flag per backend.
