# Agent Note: Remove the local Companion product substitute

Status: implemented

English | [中文](2026-08-23-remove-local-companion-product-substitute.zh.md)

## Problem

Mobile and Desktop once selected a long-running local Companion composition so simulators could exercise Account recovery, Personal Pairing, Relay, and presentation before the operated Platform path existed. That composition combined a fixed public identity, memory Account and pairing stores, a bundled test certificate, fixed Relay attachment ids, a one-byte synchronization frame, and an in-process Companion authority. Its product selectors made a successful local run easy to misstate as evidence for the operated product.

The composition also owned useful pending-login recovery behavior. Removing the local server without separating that recovery would make a Mobile authorization attempt disappear when the system browser returned to a recreated WebView.

## Decision

The bundled Desktop and Mobile entries select only the operated production identity, real Platform Account and Personal Pairing clients, credential-bound Relay, and the Snow encrypted Companion channel. `examples/local-companion-platform`, the development Companion channel, fixed development attachment ids, one-byte synchronization frames, page-origin rewrites, bundled Companion certificates, and development product flags are absent. Ports 5173 and 5174 and `prototype-companion` cannot serve as product acceptance origins.

`PlatformAccountInstallation.load()` still resumes a valid persisted authorization attempt as polling and clears an expired attempt. Packaged Mobile authorization uses the Capacitor system-browser adapter from the prepared authorization button. This recovery belongs to the Account client and does not require a local Platform, a fake identity, a custom-URL token, or a product development mode.

Keyless tests may inject memory transports, deterministic handshake fixtures, or authenticated projection fixtures through test-only composition inputs. Those fixtures cannot be selected by `main.tsx`, Desktop production configuration, or a release build. `verify-companion-product-entry` and the Mobile product-purity test reject development product selectors, proof-only Companion examples, prohibited prototype ports, fixed attachment ids, one-byte synchronization frames, and plaintext Relay authority in product entry files.

## Alternatives considered

**Keep the local composition behind a development flag.** Rejected because the product entry and release bundle would retain an alternate identity, trust root, protocol discriminator, and authority implementation. A flag does not prevent that path from being mistaken for operated acceptance or drifting from the shipped protocol.

**Keep the local server only for pending-login recovery.** Rejected because authorization recovery is durable Account-client state. Coupling it to an in-memory server and test certificate would preserve unrelated product substitutions and make browser return behavior depend on a development deployment.

**Retain a single-command local end-to-end product rehearsal.** Rejected because it gives up exact operated identity, durable stores, credential authority, and network topology. Component tests and protocol fixtures remain fast local evidence; product rehearsal uses the actual Platform and native packages.

## Verification

The product-entry verifier scans every Desktop and Mobile entry closure rather than one named file. Mobile tests prove valid pending attempts resume, expired attempts clear, the system-browser adapter opens from user activation, and product composition has no development selector. The exact checked-in Snow JS/WASM package runs on Node 22 and 24, iOS Simulator WKWebView, and Android Emulator WebView. Operated acceptance pairs the packaged Mobile entry with the packaged Desktop through the production Platform; local Vite and injected snapshots do not satisfy that evidence.

## Consequences

Developers lose the former one-command loopback product substitute and its offline fake Account identity. Local tests still cover recovery, protocol, presentation, and failure behavior through explicit fixtures, while release evidence must use the same identity, stores, authorization, Relay, and encrypted channel as the shipped application.

A future local scenario may return only as an isolated test or example that cannot enter either product dependency closure, reuse the production identity, add fixed attachment ids or synchronization sentinels, or count as release acceptance. Reintroducing a selectable local product mode requires a new decision that explains why operated staging cannot supply the needed evidence.
