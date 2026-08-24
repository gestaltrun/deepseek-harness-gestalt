# Agent Note: Share Web presentation with Mobile Companion

Status: implemented

English | [中文](2026-08-22-shared-mobile-web-presentation.zh.md)

## Problem

Mobile Companion rendered a private `MobileContentBlock` union with its own Markdown, code, image, Tool, diff, Approval, Ask User, terminal, and composer markup. Shared colors could make that tree resemble the Desktop Session Surface, but behavior, accessibility, failure handling, unknown content, and future render-intent changes still had two implementations. The prototype projection also accepted labels and lines that no Desktop-authoritative Client Runtime projection produced.

## Decision

The Web presentation owners expose explicit `./presentation` entries. `ui-workspace` owns `SessionListState` grouping and `SessionNodeItem` rows; `ui-conversation` owns the authoritative keyed router for every finalized `ConversationNode`, Approval, and the narrow `InputBarPresentation` interface; `ui-tool` owns recursive Tool presentation, the built-in keyed roster, and unknown-Tool fallback; `ui-user-questions` owns Ask User; and `ui-attachment` owns message images. `ui-theme` exposes stable stylesheet subpaths. These entries are public product interfaces, while plugin-only skeleton paths and CSS Modules remain private.

Dynamic Client plugin packages build these browser ESM entries with `browserSubpath`. That build face keeps bare dependencies and emitted CSS under the importing product shell without classifying the package as a Desktop static-linked package; its primary `dsh.client` module-table entry remains unchanged.

The encrypted channel transfers a JSON Mobile projection rather than Client Runtime objects. Conversation collections and turn indexes use arrays, while pending interactions carry only ids and domain payloads. The authenticated adapter validates every required conversation field and known node, content, pending-payload, and Tool presentation discriminant before publication, normalizes future node kinds into the shared unknown-node presentation, preserves unknown Tool cards as extensible render intents, and constructs the exact `SessionListState`, `WorkspaceView`, `ConversationSnapshot`, `ConversationNode`, `ToolCallBlock`, and `PendingWait` presentation values locally. Each physical connection atomically binds its receiver, content adapter, and mutation adapter; local pending responders return the generation-bound channel's settlement receipt, and old responders cannot dispatch after reconnect.

`MobileBrowse` retains phone navigation but owns neither a Session summary/list renderer nor a conversation-node router. Shared Session rows own keyboard focus and activation semantics. The full-screen detail root binds the same content width, composer gutter, card width, and long-draft cap normally inherited from Desktop `ConversationRoot`. A subscribed presentation clock updates relative time, and Session-addressed history requests replace the authoritative page. The production surface admits mutation only when the current physical generation is synchronized and its authenticated channel is active; lifecycle state alone cannot enable a callback. `main.tsx` selects only the operated Account, pairing, Relay, and Snow product adapters through `launchMobileProduct`; production invokes the operated start callback, while the bundled browser test resolves that one launch dependency to explicit fixture composition. Mobile does not mount Desktop columns, Settings, model selection, plugin configuration, or terminal input.

The full Desktop `InputBar` and `ConversationComposer` use the same owner-defined editor and primary-action presentation implementations. Desktop and direct compositions also share owner-defined narrow Approval and question components rather than fabricated framework kits or Session hooks. `ConversationComposer` owns a local `InputMachine` draft, settles synchronous transport throws as rejected submissions, and delegates admitted prompt and cancellation operations to the caller; it supplies no annotation, attachment, slot, projection, command, or Host stand-ins. The encrypted Companion Session transport remains responsible for supplying authoritative snapshots and callbacks to the bundled Mobile entry.

Desktop keyed slots and `ToolPresentation` use one built-in Tool roster. Bash, read, write/edit, grep/glob, Web, todo, and question calls mount their specialized owner rows; `GenericToolCard` renders only unclaimed wire names. Direct composition passes the authoritative `ToolCallBlock`, cwd, and home values into `DirectToolCallTree` without constructing a Chat Node or Host description.

## Verification

Mobile component tests convert JSON projections through the authenticated adapter and cover malformed known nodes, content, Tool presentation intents, and pending payloads, future-node and future-Tool-card extension behavior, shared keyboard Session rows, specialized ordinary and unknown Tools, images, Approval, Ask User, accepted and rejected settlement receipts, generation replacement, multi-page history, subscribed time, InputBar submission, locale, theme, overflow, and Host errors. The keyless browser snapshot builds and loads the bundled `main.tsx` entry, resolves its launch dependency to an authenticated generation-bound fixture, and at 390 px executes Markdown, code, image, known and unknown Tool, diff, Host error, future-node fallback, Approval, Ask User, and long composer content in English/dark and Chinese/light contexts. It asserts bounded scrolling, reachable actions, the shared CSS variables, zero horizontal page overflow, and a non-5173/5174 origin. The snapshot runs no model round and proves neither the operated Platform nor a live Paired Desktop. `verify-companion-product-entry` and the Mobile product-purity test reject development product selectors, proof-only Companion examples, prohibited prototype ports, fixed attachment ids, one-byte synchronization frames, and plaintext Relay authority from product entry files. Native release evidence executes the exact checked-in Snow JS/WASM package in iOS Simulator WKWebView and Android Emulator WebView. No acceptance uses `prototype-companion` or ports 5173/5174.

## Alternatives considered

**Share only CSS and domain labels.** Rejected because two rendering trees would continue to diverge in semantics, keyboard behavior, unknown content, and structured Tool output.

**Mount the complete Desktop slot tree at phone width.** Rejected because Desktop navigation, details columns, Settings, model selection, plugin configuration, and terminal affordances exceed Companion Surface authority and produce an unusable narrow layout.

**Create a new generic Mobile transcript model between the Runtime and React.** Rejected because it would duplicate the authoritative Client projection and require another conversion whenever a Conversation Node or render intent changes.

## Consequences

One presentation fix reaches Desktop and Mobile components, and Mobile tests exercise the same implementation files as Desktop. Public presentation entries enlarge the supported package interface and therefore require package documentation, build/export checks, and deliberate compatibility changes. The Mobile bundle also includes the shared Markdown and syntax-highlighting assets, increasing its initial artifact size. The JSON adapter is a transport representation, not a second presentation model: it exists only to reconstruct the shared carriers without sending runtime classes or closures. The encrypted Companion v3 channel supplies the authoritative projection and generation-bound content and mutation adapters; product acceptance still requires the assembled operated Platform, Desktop, and Mobile flow rather than a component snapshot.
