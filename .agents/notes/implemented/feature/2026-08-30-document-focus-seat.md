# Agent Note: document focus seat in the details panel

Status: implemented

English | [中文](2026-08-30-document-focus-seat.zh.md)

## Problem

A routed member-question names referenced documents as material chips, but the receiver needs a contained surface to read them. The details panel otherwise knows only the tool-selection channel, and a chip without document focus is inert text — the referenced `.md`/`.html` bodies that ride the relay have nowhere to render.

## Decision

The details panel gains a second, mutually exclusive body: document focus. `ChatStoreState.documentFocus` carries a `DetailsDocumentFocus` (path, filename, provenance, optional inline body); writing it and opening the panel is one gesture through the optional `ctx.get('detailsFocus')` service ui-conversation provides — the per-session bound actions are stashed by the details registration's inject (the `LayoutController.attachPanels` assembly pattern), so a plugin that cannot reach the chat store can still focus a document. A contributor resolves this optional service when the user activates a chip, so a provider registered after the contributor becomes available and a released provider returns the linkage to a no-op. The panel close and the next tool selection each clear the focus, keeping the two bodies exclusive.

The `conversation.details.document` seat mirrors `conversation.details.tool`: one session-scoped occupant over the panel's three-way fallback dispatch, keyed by extension — `.md`/`.markdown` renders the carried body through MarkdownText, `.html`/`.htm` renders the restricted preview with no sandbox grants, an inert tag-and-attribute allowlist, and a first-document `default-src 'none'` content policy (the amber 「受限预览 · 脚本与网络请求已禁用」 strip remains above it), and every other extension renders a bare file tab (icon, filename, 「来自 {name}」) with no download affordance. Sanitization retains text and inert document structure while dropping active, embedded, form, style, refresh, and self-navigation capabilities; the sandbox blocks script, forms, popups, and top navigation; the content policy blocks requests from the surviving passive image source.

The composite card owns the linkage on both ends. Chips are buttons that call `focusDocument`; when the details panel opens the card folds to its collapsed strip by observing `aria-expanded` on the persistent `[data-details-panel]` details column (ui-layout), the same observation mechanism that watches the shared presentation's minimize toggle. Activating that strip restores the card without closing the panel, keeping the document and decision side by side; closing the panel also leaves the card restored. `references` carries optional inline `content` (mirrored in `askUserQuestionItemSchema` as optional) so renderable bodies arrive with the relay; a reference without content renders as the bare file tab, and an absent `detailsFocus` service renders the chips inert.

## Alternatives considered

**Focus state outside the chat store (a layout or plugin-local store).** Rejected: the details panel already reads per-session panel state from the shared chat-store seat, and a second channel would need its own session scoping and persistence story for no new capability.

**Pushing fold state into the card from conversation.** Rejected: the card already derives fold from observed `aria-expanded` facts; the details column exposing its open state the same way keeps ui-member-questions free of layout imports.

## Consequences

Tool selection and document focus never mix: selecting a tool replaces a focused document, and closing the panel returns the next open to the tool selection. The markdown/html dispatch renders only what the relay carried — there is still no receiver-side filesystem read — so a reference the sender sent without an inline body degrades to identity, never to a failed load.

## Testing

`packages/client/ui-conversation/tests/details-document-focus.client.spec.tsx` pins the three-way dispatch (markdown heading, grant-free sandbox, sanitized navigation, deny-all content policy, and bare file tab without a download affordance), the seat's owner currency, and the focus write-and-clear channel. `packages/client/ui-member-questions/tests/member-questions-apply.client.spec.ts` pins late provider registration, release, and contribution disposal. The card test pins chip payload, restoration beside an open panel, subsequent native minimization, and a later details-panel reopening. The assembled Web scenario presents hostile passive, active, refresh, and link-navigation requests while a server tripwire proves that no request arrives; it clicks the sanitized link text, restores the card without closing details, and answers through the shared presentation.
