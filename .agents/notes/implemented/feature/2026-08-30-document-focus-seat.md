# Agent Note: document focus seat in the details panel

Status: implemented

English | [中文](2026-08-30-document-focus-seat.zh.md)

## Problem

Ticket #344 M3: a routed member-question names referenced documents as material chips, but the receiver had no surface to read them. The details panel knew only the tool-selection channel, and a chip was inert text — the referenced `.md`/`.html` bodies that rode the relay had nowhere to render.

## Decision

The details panel gains a second, mutually exclusive body: document focus. `ChatStoreState.documentFocus` carries a `DetailsDocumentFocus` (path, filename, provenance, optional inline body); writing it and opening the panel is one gesture through the optional `ctx.get('detailsFocus')` service ui-conversation provides — the per-session bound actions are stashed by the details registration's inject (the `LayoutController.attachPanels` assembly pattern), so a plugin that cannot reach the chat store can still focus a document. The panel close and the next tool selection each clear the focus, keeping the two bodies exclusive.

The `conversation.details.document` seat mirrors `conversation.details.tool`: one session-scoped occupant over the panel's three-way fallback dispatch, keyed by extension — `.md`/`.markdown` renders the carried body through MarkdownText, `.html`/`.htm` renders the sandboxed restricted preview (`sandbox="allow-same-origin"` only: no script grant, no network path, with the amber 「受限预览 · 脚本与网络请求已禁用」 strip above), and every other extension renders a bare file tab (icon, filename, 「来自 {name}」) with no download affordance.

The composite card owns the linkage on both ends. Chips are buttons that call `focusDocument`; while the details panel is open the card folds to its collapsed strip by observing `aria-expanded` on the persistent `[data-details-panel]` details column (ui-layout), the same observation mechanism that already watched the shared presentation's minimize toggle — the column is kept mounted at width 0 precisely so an attribute, not a mount, is the open-state channel. Closing the panel restores the card. `references` grows an optional inline `content` (mirrored in `askUserQuestionItemSchema` as optional) so renderable bodies arrive with the relay; a reference without content renders as the bare file tab, and an absent `detailsFocus` service renders the chips inert.

## Alternatives considered

**Focus state outside the chat store (a layout or plugin-local store).** Rejected: the details panel already reads per-session panel state from the shared chat-store seat, and a second channel would need its own session scoping and persistence story for no new capability.

**Pushing fold state into the card from conversation.** Rejected: the card already derives fold from observed `aria-expanded` facts; the details column exposing its open state the same way keeps ui-member-questions free of layout imports.

## Consequences

Tool selection and document focus never mix: selecting a tool replaces a focused document, and closing the panel returns the next open to the tool selection. The markdown/html dispatch renders only what the relay carried — there is still no receiver-side filesystem read — so a reference the sender sent without an inline body degrades to identity, never to a failed load.

## Testing

`packages/client/ui-conversation/tests/details-document-focus.client.spec.tsx` pins the three-way dispatch (markdown heading, sandbox attribute with no `allow-scripts`, bare file tab without a download affordance), the seat's owner currency, and the focus write-and-clear channel. `packages/client/ui-member-questions/tests/member-questions-card.client.spec.tsx` pins chip → `focusDocument` payload and the open → fold → close → restore round-trip. `packages/host/apiproxy/tests/rpc-schemas.spec.ts` and `packages/client/ui-theme/tests/scrollbar-styles.client.spec.ts` cover the wire field and the elevated-surface rebind the card sheet now declares.
