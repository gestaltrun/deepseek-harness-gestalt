# ui-member-questions — member-question composer takeover

English | [中文](README.zh.md)

Presents member-directed `ask_user_question` requests as a composite card: the remote Decision Brief banner (remote tag, asker identity and role, project, source session, expiry countdown, clamped background, material chips) over the shared question presentation, which keeps pagination, multi-select, recommendation badges, custom answers, and settlement as its native behavior.

The package registers a selector-routed entry of the `conversation.composer` chain ahead of the shared question composer: a pending request whose whole batch declares the `member-question` presentation intent elects this wrapper; `plan-review` and generic requests keep electing the shared composer unchanged. Observing the shared presentation's own minimize toggle folds the whole card to a 「远端 · 发起人」 strip and marks it collapsed; the presentation stays mounted, so its drafts survive.

Material chips are focus buttons: clicking one writes that document into the session's details panel through the optional `detailsFocus` service, where the `conversation.details.document` seat dispatches by extension — markdown bodies through MarkdownText, html bodies through the sandboxed restricted preview, everything else as a bare file tab. The card initially folds when the details panel opens; activating its strip restores the document and decision side by side without closing the panel.

`ReceivingQuestionBook` enforces the carried expiry instant with one timer for the earliest active question. Expiry settles and removes the pending wait, so the shared presentation cannot submit a late answer; the card countdown displays the same deadline.

## Model Experience

None, as the package is browser-side composer chrome: the selector-routed card renders questions the shared ask-user presentation already carries and answers through that presentation's settlement, registering no prompt, schema, or tool of its own.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Takeover is all-or-nothing per batch** — a pending request elects this card only when every question in the batch declares the `member-question` intent; one generic or `plan-review` question sends the whole batch to the shared composer, and no per-question split exists.
- **Material chips need the composition's `detailsFocus` service** — without that optional service the chips render but write no document into a details panel, so the referenced materials stay list-only.
