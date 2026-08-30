# ui-member-questions — member-question composer dock

English | [中文](README.zh.md)

Presents member-directed `ask_user_question` requests as a composite card: the remote Decision Brief banner (remote tag, asker identity and role, project, source session, expiry countdown, clamped background, material chips) over the shared question presentation, which keeps pagination, multi-select, recommendation badges, custom answers, and settlement as its native behavior.

The package registers an additive `conversation.input.dock` entry above the product composer. A pending request whose whole batch declares the `member-question` presentation intent renders the Decision Brief there; `plan-review` and generic requests keep using the shared question takeover. Observing the shared presentation's own minimize toggle folds the whole card to a 「远端 · 发起人」 strip and marks it collapsed; the presentation stays mounted, so its drafts survive.

Material chips are focus buttons: clicking one writes that document into the session's details panel through the optional `detailsFocus` service, where the `conversation.details.document` seat dispatches by extension — markdown bodies through MarkdownText, html bodies through the sandboxed restricted preview, everything else as a bare file tab. The card initially folds when the details panel opens; activating its strip restores the document and decision side by side without closing the panel.

`ReceivingQuestionBook` builds the card only from the Host receiver snapshot and change feed. The countdown is display-only; expiry, supersession, withdrawal, and every terminal state arrive from the Host. Answer and decline actions use the Host settlement RPC through the shared presentation.

Answered, declined, expired, withdrawn, and superseded records remain visible as passive bands after the pending card disappears. An answer won by another Installation renders as answered elsewhere with the winning device name and settlement time. The unchanged product composer submits through the receiving face's single admission RPC; the card does not mount a second textarea and the renderer does not issue separate Session creation and prompt calls.

## Model Experience

None, as the package is browser-side composer chrome: the selector-routed card renders questions the shared ask-user presentation already carries and answers through that presentation's settlement, registering no prompt, schema, or tool of its own.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Dock routing is all-or-nothing per batch** — the card renders only when every question in the batch declares the `member-question` intent; one generic or `plan-review` question sends the whole batch to the shared question composer, and no per-question split exists.
- **Material chips need the composition's `detailsFocus` service** — without that optional service the chips render but write no document into a details panel, so the referenced materials stay list-only.
- **Admission failures remain on the receiving card** — the shared input state keeps the draft and exposes the Host diagnostic. Only a successful Host materialization unlocks ordinary model, command, and skill routes.
