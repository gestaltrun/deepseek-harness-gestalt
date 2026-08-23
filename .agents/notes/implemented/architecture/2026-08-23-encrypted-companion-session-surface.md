# Agent Note: Carry the shared Session surface over Companion

Status: implemented

English | [中文](2026-08-23-encrypted-companion-session-surface.zh.md)

## Problem

The [shared Mobile Web presentation](2026-08-22-shared-mobile-web-presentation.md) could reconstruct Desktop presentation values, but the encrypted product channel supplied only foreground authority, search, and attachment operations. Session discovery, history, mutations, pending human interactions, and historical image bytes still lacked one bounded protocol and Host owner, so a rendered shared component did not prove that the paired Desktop was its authority.

## Decision

Encrypted Companion Protocol major 3 is the allowlist between the paired endpoints. Desktop projects bounded Session and Workspace rows plus complete conversation pages; Mobile sends history, prompt, cancellation, Approval, Ask User, and image-read operations with opaque operation correlation. Every mutation executes through a pairing-scoped durable ledger. Concurrent retries of one operation share one Host effect, a failed commit save retains the terminal result for durable retry, records expire after seven days, and capacity evicts the oldest terminal records before refusing unresolved work. Durable records parse branded identities and complete v3 results and require the record and result operation ids to match. The Desktop owner calls only the named Web Host methods and converts HTTP, wire, business, and timeout failures into correlated protocol results; it never accepts an arbitrary Host RPC name or payload.

One physical Snow generation owns the Mobile decoder, mutation adapter, content adapter, and shared `MobileCompanionSurface` binding. A replacement invalidates pending settlement, prompt confirmation, and image work. The composer awaits Desktop prompt confirmation; correlated failure rejects that promise and remains visible. A tail history response replaces the conversation, while `loadOlder` sends the oldest visible sequence as `beforeSeq` and prepends a continuity-checked single-flight page. Desktop refreshes real Host running state with every history response, so the shared Stop control reflects authority. Retry lifecycle events use the shared `model-retry` node and suppress the terminal error superseded by that retry. Confirmed prompt, cancellation, and interaction mutations request a bounded authoritative history and list refresh instead of adding another live transport. Pending Host rpc ids stay on Desktop; Mobile receives pairing-private HMAC interaction ids and reconstructs the shared `PendingWait` responder locally. Session creation is absent from major 3, so the shipped entry supplies no New Session handler.

Historical images use the Session's content-addressed attachment id. Desktop reads exact bytes through the Host attachment method, splits at most 16 MiB into ordered 32 KiB protocol chunks, and repeats one SHA-256 digest. Mobile correlates every chunk with its operation, Session, attachment, media type, generation, index, count, and digest before returning a data URL to the shared `ImageGallery`. The loopback RPC retains the ordinary 60 KiB response ceiling for ordinary methods and uses the operated attachment deadline plus a fixed maximum-image response ceiling only for `session.attachment`.

## Verification

The assembled Desktop test starts real file Session persistence, Workspace storage, attachment storage, Host API, and random-port HTTP; establishes endpoint-owned XKpsk3 and fresh IK Snow channels; then carries discovery, history, prompt, cancellation, Host Ask User and Approval settlement, and multi-chunk image bytes into `MobileCompanionSurface`. Codec tests reject optional-field mistakes, extra fields, malformed attachment ids, and limit overflow. Mobile tests pin operation correlation, history prepend continuity, digest verification, generation replacement, awaited prompt failure, correlated failure settlement, hidden creation controls, and refresh-after-mutation behavior. No product evidence uses `prototype-companion`, ports 5173/5174, a Memory authority, or keyless cryptography.

## Alternatives considered

**Tunnel Host RPC over Snow.** Rejected because it would grant a separately released Mobile client every current and future Host method and couple Companion compatibility to Host envelopes.

**Send Client Runtime classes and responders.** Rejected because maps, closures, and Host rpc ids are process-local authority. The JSON protocol carries data only, and the authenticated Mobile adapter reconstructs the [shared presentation](2026-08-22-shared-mobile-web-presentation.md).

**Add a general live event stream.** Rejected because foreground synchronization, mutation confirmations, and bounded refreshes provide the required ownership without another multiplexed transport and replay model.

## Consequences

Mobile uses the same Web renderers for real paired-Desktop Sessions while Desktop remains the Session, search, interaction, and attachment authority. Major 3 has strict limits and rejects unknown fields, so extending the product requires an explicit next protocol change rather than an incidental Host addition. Session creation remains unavailable. Physical WKWebView and Android WebView execution plus independent review of the exact Snow implementation remain release evidence outside repository assembly.
