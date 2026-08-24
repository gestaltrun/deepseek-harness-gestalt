# Agent Note: Use the real Companion product path

Status: proposed

English | [中文](2026-08-22-real-companion-product-path.zh.md)

## Problem

Mobile Companion has production-capable Account, pairing, Relay, attachment, Session, and shared Client packages, but its assembled Desktop and Mobile path still depends on a proof-only identity, in-memory Platform stores, a bundled localhost certificate, keyless providers, shared attachment ids, an unauthenticated one-byte synchronization signal, placeholder device and attachment values, disabled full-text search, and Mobile-owned content renderers. Local Vite and `prototype-companion` evidence can therefore pass while the shipped product path remains unproved. The accepted Mobile Companion proposal also requires APNs and FCM, while the current product decision removes push delivery and requires foreground synchronization instead.

## Proposal

Product Desktop and Mobile compose only the operated HTTPS Platform identity, real GitHub Account flow, durable Platform providers, and the reviewed per-pairing encrypted channel. Test identities, memory providers, test certificates, keyless handshakes, fixed Relay attachment ids, and proof-only synchronization frames remain available only to bounded tests whose names and assertions cannot be cited as product acceptance.

The operated identity, durable resource composition, and product-entry import gate are implemented by [Bind Companion products to one operated Platform identity](../../implemented/architecture/2026-08-22-operated-companion-platform-identity.md).

Each Personal Pairing owns its Mobile and Desktop attachment identities, route credentials, application keys, and authenticated synchronization. Snow completes XKpsk3 pairing and IK reconnect with fresh ephemeral keys. A versioned Encrypted Companion message carries synchronization; Relay authority is sealed to the pairing-derived channel and never appears as application or Platform-visible plaintext.

Mobile presents the authenticated Installation name and platform, scans the complete Pairing Challenge through browser camera APIs, and retains the full-link fallback. Two phones remain independently paired and revocable without sharing a key, attachment id, device record, or online state.

Mobile attachments use the pairing-scoped encrypted blob capability and reach the existing Desktop Session attachment path as bytes. Desktop activates its full-text Session provider for product search. Host HTTP status, wire failures, typed business errors, and timeouts become stable Companion results and visible Mobile states.

The Companion Surface is a phone-sized composition of exported DSH Web components. Mobile owns navigation, selected-Desktop state, and remote-authority adaptation; shared Web packages own Markdown, code, image, tool, diff, approval, Ask User, error, terminal-summary, and composer presentation. Importing private Desktop CSS modules or reimplementing those renderers does not satisfy component reuse.

Mobile Companion has no push capability. APNs and FCM adapters, tokens, payloads, persistence, configuration, quotas, metrics, secrets, native dependencies, and acceptance requirements are deleted by the [foreground-only synchronization decision](../../implemented/simplification/2026-08-22-foreground-only-companion-synchronization.md). Backgrounding pauses the Relay connection; opening or foregrounding the application reconnects and completes Desktop-authoritative synchronization before enabling a mutation. Deep links may remain only when they carry no stale interaction authority and do not depend on push delivery.

Product acceptance runs the shipped Mobile entry, the operated non-sticky two-instance Platform, and a real Paired Desktop. `apps/mobile/prototype-companion`, Vite ports 5173/5174, fake identities, in-memory stores, test certificates, and test-only providers are prohibited as acceptance origins.

## Alternatives considered

**Promote the local Companion listen after replacing individual fixtures.** Rejected because the composition itself owns fake identity, memory authority, localhost trust, and keyless transport; incremental substitution would leave a second product path and ambiguous acceptance evidence.

**Keep Mobile-specific renderers but share CSS and domain types.** Rejected because behavior, accessibility, unknown-content fallback, and interaction presentation would continue to diverge even when the pages look similar.

**Keep APNs/FCM as dormant adapters.** Rejected because dormant schemas, secrets, token lifecycle, quotas, and native dependencies preserve an unsupported capability and keep operation and privacy obligations alive.

**Treat local Vite plus Electron as assembled acceptance.** Rejected because it does not prove the shipped Mobile entry, operated identity, durable two-instance routing, device isolation, native runtime, or real trust chain.

## Acceptance criteria

- Product entrypoints cannot select the local proof identity, memory Platform, bundled certificate, keyless channel, fixed attachment ids, or one-byte synchronization.
- Two authenticated Mobile Installations pair concurrently with independent Device Principals and operate one real Paired Desktop through the operated two-instance Platform.
- Pairing and reconnect use the reviewed Snow product channel for every Encrypted Companion message and sealed Relay authority.
- Browser camera and full-link pairing, encrypted attachment bytes, full-text Session search, and Host failure projection pass through the real product entries.
- Mobile and Desktop execute the same exported Web presentation components for every shared content category.
- Shipped source and configuration contain no APNs/FCM capability, token, secret, quota, payload, provider, or native dependency.
- Product acceptance contains no request to ports 5173/5174 and imports no `prototype-companion` or local proof provider.

## Risks

Removing push means the product cannot alert a backgrounded phone; the user must open or foreground Mobile Companion before it can learn current Desktop state. Shared Web components may require deeper public interfaces so phone layout remains independent without exposing Desktop authority. The real assembled test remains blocked until the operated Platform and review-approved channel are available, and production deployment or mobile distribution still requires separate authorization.
