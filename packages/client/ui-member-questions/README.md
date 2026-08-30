# ui-member-questions — member-question composer takeover

English | [中文](README.zh.md) *(planned — bilingual pairing lands with the receiver-experience docs milestone)*

Presents member-directed `ask_user_question` requests as a composite card: the remote Decision Brief banner (remote tag, asker identity and role, project, source session, expiry countdown, clamped background, material chips) over the shared question presentation, which keeps pagination, multi-select, recommendation badges, custom answers, and settlement as its native behavior.

## Model Experience

No model-facing surface. The package registers a selector-routed entry of the `conversation.composer` chain ahead of the shared question composer: a pending request whose whole batch declares the `member-question` presentation intent elects this wrapper; `plan-review` and generic requests keep electing the shared composer unchanged. Observing the shared presentation's own minimize toggle folds the whole card to a 「远端 · 发起人」 strip and marks it collapsed; the presentation stays mounted, so its drafts survive.

Material chips are focus buttons: clicking one writes that document into the session's details panel through the optional `detailsFocus` service, where the `conversation.details.document` seat dispatches by extension — markdown bodies through MarkdownText, html bodies through the sandboxed restricted preview, everything else as a bare file tab. While the details panel is open the card folds to its strip, observed the same way as the minimize toggle: via the persistent details column's `aria-expanded`.
