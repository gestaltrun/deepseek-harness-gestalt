# Agent Note: Mobile clock skew and Installation proof replay window

Status: implemented

English | [中文](2026-08-30-mobile-clock-skew-proof-window.zh.md)

## Problem

An Installation signs each Platform Account operation with its local timestamp. A consumer phone can differ from the Platform clock by more than sixty seconds even while GitHub authorization, TLS, and network delivery all succeed. Rejecting that proof prevents Account login and every authenticated Companion operation although the Installation still possesses the correct private key.

Accepting future-dated proofs also extends their remaining validity past the server receipt time. Expiring a consumed proof id from that receipt time can therefore release the replay record while the same signed proof is still inside its accepted timestamp window.

## Decision

Platform Account accepts a signed Installation proof when its issue time is within five minutes of the Platform clock. The proof continues to bind the exact operation and token-derived value, and signature verification precedes atomic `jti` consumption. This bounded minutes-scale allowance follows the clock-offset guidance in [OAuth DPoP proof replay](https://www.rfc-editor.org/rfc/rfc9449.html#section-11.1).

The shared Account backend retains a consumed `jti` until `issuedAt + ACCOUNT_PROOF_WINDOW_MS`. A proof issued ahead of the server clock therefore remains replay-blocked for its complete validity, rather than only for five minutes after first receipt.

## Alternatives considered

**Require automatic device time.** A consumer application cannot enforce the phone's time source, and the resulting proof diagnostic does not provide a viable recovery path after successful OAuth authorization.

**Replace client time with a server nonce.** A server-managed nonce removes clock dependence, but it adds a new wire value and lifecycle to every Account proof producer and verifier. The existing operation binding, signature, bounded lifetime, and shared single-use `jti` provide the required protection without that protocol expansion.

**Accept only proofs from clocks behind Platform.** Device clocks can lead or lag, so an asymmetric rule converts the same ordinary skew into a direction-dependent failure.

## Testing

The Platform Account provider test signs current-Account proofs from clocks three minutes behind and ahead. It requires both proofs to succeed, requires exact replay to fail, advances the server beyond the first-receipt retention point while the future proof remains valid, and still requires replay rejection. Existing invalid-time, signature, and backend tests retain rejection beyond the five-minute window.

The physical-iPhone Mobilewright acceptance signs in through the production GitHub callback after Platform deploy and then continues through explicit-link Personal Pairing without camera access.

## Consequences

A captured proof can satisfy the timestamp check for at most five minutes instead of one. Exact operation and token binding prevent use for another request, and shared `jti` consumption keeps the accepted proof single-use for that complete interval. Replay storage retains entries for up to five minutes plus accepted future skew; this bounded increase buys tolerance for ordinary mobile clock differences.
