# ui-member-questions — member-question composer dock

English | [中文](README.zh.md)

Presents member-directed `ask_user_question` requests as a composite card: the remote Decision Brief banner (remote tag, asker identity and role, project, source session, expiry countdown, clamped background, material chips) over the shared question presentation, which keeps pagination, multi-select, recommendation badges, custom answers, and settlement as its native behavior.

The package registers an additive `conversation.input.dock` entry above the product composer. A pending request whose whole batch declares the `member-question` presentation intent renders the Decision Brief there; `plan-review` and generic requests keep using the shared question takeover. Observing the shared presentation's own minimize toggle folds the whole card to a 「远端 · 发起人」 strip and marks it collapsed; the presentation stays mounted, so its drafts survive.

Material chips open the receiver-owned cached copy through Better Sidebar Files. The Host writes transferred bytes under `.dsh/member-questions/<questionId>/` so a same-named Workspace file is never overwritten or opened. Clicking a chip calls `ctx.betterSidebar.openFile` with the receiving Session id and cached path; markdown, sandboxed HTML, and unsupported types reuse the ordinary Files viewers. When the Files editor tab is unregistered, the chip falls through to `ctx.workspaces.openPath` and the Host system opener. There is no Member-Question-specific document dock.

`ReceivingQuestionBook` builds the card only from the Host receiver snapshot and change feed. The countdown is display-only; expiry, supersession, withdrawal, and every terminal state arrive from the Host. Answer and decline actions use the Host settlement RPC through the shared presentation.

Answered, declined, expired, withdrawn, and superseded records remain visible as passive bands after the pending card disappears. An answer won by another Installation renders as answered elsewhere with the winning device name and settlement time. The unchanged product composer submits through the receiving face's single admission RPC; the card does not mount a second textarea and the renderer does not issue separate Session creation and prompt calls.

## Model Experience

None, as the package is browser-side composer chrome: the selector-routed card renders questions the shared ask-user presentation already carries and answers through that presentation's settlement, registering no prompt, schema, or tool of its own.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Dock routing is all-or-nothing per batch** — the card renders only when every question in the batch declares the `member-question` intent; one generic or `plan-review` question sends the whole batch to the shared question composer, and no per-question split exists.
- **Material chips need a Files viewer or the Host system opener** — a registered Files editor tab opens the receiver-owned cache path in the receiving Session; otherwise the Host system opener is used. There is no second in-product document dock.
- **Admission failures remain on the receiving card** — the shared input state keeps the draft and exposes the Host diagnostic. Only a successful Host materialization unlocks ordinary model, command, and skill routes.
