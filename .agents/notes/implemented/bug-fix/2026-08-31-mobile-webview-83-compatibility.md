# Agent Note: Mobile WebView 83 compatibility

Status: implemented

English | [中文](2026-08-31-mobile-webview-83-compatibility.zh.md)

## Problem

The Android application accepts API 24 and newer, but its bundled browser code used APIs introduced after the Android 10 factory WebView on an operated physical phone. Missing `crypto.randomUUID` rejected product initialization, while the startup renderer itself called missing `Element.replaceChildren`; the user therefore received an empty white WebView instead of either the account surface or an actionable error.

## Decision

Android System WebView 83 is the Mobile browser-runtime floor. Both production and bundled-entry snapshot builds target Chrome 83 syntax. Before product initialization, the entry loads the maintained core-js implementations of `Object.hasOwn`, `Array.prototype.at`, `String.prototype.replaceAll`, and `AggregateError`, then installs the DOM `Element.prototype.replaceChildren` and cryptographic `crypto.randomUUID` APIs absent from that runtime. UUID generation delegates to the Mobile-owned `randomUuid()` helper, which uses `crypto.getRandomValues` and sets RFC 4122 version and variant bits. The entry never substitutes `Math.random`, Web storage, or another predictable source.

The startup renderer uses `textContent` and `append`, so missing required system cryptography remains visible even when the compatibility installer cannot provide it. Durable Companion Host failures are reconstructed by discriminant instead of depending on `structuredClone`.

## Alternatives considered

**Require users to update Android System WebView before launch.** A Google-signed WebView update is not available through every OEM store, and an independently updated system component should not turn an otherwise supported Android version into an unexplained blank screen.

**Bundle an unrestricted compatibility preset.** The signed bundle imports only the maintained core-js modules required by its audited runtime surface. A general legacy preset adds bytes and behavior without a current consumer.

**Generate identifiers with a local pseudo-random fallback.** Installation, proof, Relay, and Companion operation identifiers are security-sensitive correlation values. Only system cryptographic random bytes satisfy that obligation.

## Testing

Focused tests verify the compatibility APIs, standards-compatible replacement tokens, DOM child replacement, and deterministic UUID version and variant bits. Protected-storage tests require cryptographic bytes and preserve the Installation id across restart. The Chrome-83-targeted bundled-entry snapshot removes every compatibility API before navigation, then proves the real entry installs them before rendering the authenticated product surface. The product-entry test also requires missing random bytes to render the bilingual startup alert.

A physical Android 10 / MIUI 12.5.2 phone with Google System WebView 83 launches the operated Debug bundle through Mobilewright and renders the Platform Account privacy surface. The same device remains unable to reach the production ALB because WebView TLS fails with `net_error -101`; this transport result is separate from the fixed blank-render failure.

## Consequences

The Mobile bundle carries a small early compatibility module and can run its current account and Companion code on WebView 83 without weakening identifier generation. New browser APIs added to the signed bundle must either satisfy this floor or extend the same focused compatibility owner and physical-device test. The browser runtime can now expose production transport incompatibility directly instead of hiding it behind a white screen.
