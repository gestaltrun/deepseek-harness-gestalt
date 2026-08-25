# Agent Note: Authorize Every Endpoint Pairing Request Separately

Status: implemented

English | [中文](2026-08-25-fresh-installation-proof-per-pairing-request.zh.md)

## Problem

Mobile authorized an endpoint pairing status poll once and reused that one-use Installation proof when it submitted XKpsk3 message3. The Platform consumed the proof during the status request and rejected message3 as `PROOF_REPLAYED`, leaving a real Mobile pairing retryable after message2.

## Decision

Every endpoint pairing HTTP operation obtains a fresh `authorizeCurrentInstallation()` result immediately before its transport call. In particular, message3 submission does not inherit authentication from the status poll that returned message2. Pairing retry state retains protocol progress, not reusable Account proof material.

## Alternatives considered

**Permit one proof across the status and message3 pair.** Rejected because it weakens the one-operation proof replay rule and makes proof validity depend on a multi-request client sequence.

**Skip the status proof after message1.** Rejected because mailbox reads expose Account-bound pairing progress and remain authenticated Platform operations.

**Retry message3 with a fresh proof only after `PROOF_REPLAYED`.** Rejected because replay rejection is a security signal, not normal flow control, and the first invalid request would remain observable in operated logs.

## Consequences

Status polling and message3 carry distinct proof JTIs while preserving the same pairing attempt and handshake transcript. Additional proof signing occurs once per HTTP operation. A consumed, retried, or reordered request cannot donate its proof to another pairing operation.

## Testing

The controller regression records the authorizations delivered to status and message3 and requires distinct JTIs. The shipped Android App reaches authentication words and Desktop confirmation through the operated Platform without a proof replay response.
