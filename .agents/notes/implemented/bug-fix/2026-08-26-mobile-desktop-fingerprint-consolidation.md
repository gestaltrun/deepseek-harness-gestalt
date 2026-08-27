# Agent Note: Consolidate Re-paired Desktop Authority

Status: implemented

English | [中文](2026-08-26-mobile-desktop-fingerprint-consolidation.zh.md)

## Problem

Electron dev and packaged Desktop use independent installation records. Pairing both copies on one computer gave Mobile two valid Personal Pairings with the same Desktop name, so the Paired Desktop selector displayed duplicate rows and retained duplicate authority.

## Decision

The account-scoped Mobile pairing vault normalizes an authenticated Desktop name with Unicode NFKC, trimming, and case folding as a simple device fingerprint. When the selected authenticated pairing matches older retained pairings, the Mobile controller revokes each older Platform pairing with a fresh installation proof before releasing its local keys and removing its row. A failed Platform revocation retains the older authority for retry instead of hiding it.

## Alternatives considered

**Hide duplicate rows in React.** Rejected because the older Platform principal and local pairing keys would remain valid while becoming invisible.

**Delete local duplicate keys before Platform revocation.** Rejected because a network failure would strand active Platform authority without the local identity needed to retry cleanup.

**Collect a hardware serial number.** Rejected because this pre-release Desktop flow only needs a local product hint and does not justify collecting a stronger cross-installation hardware identifier.

## Consequences

Re-pairing the same named Desktop replaces its older authority after authenticated foreground synchronization. Distinct computers intentionally configured with the same normalized name are treated as one Desktop; supporting that case requires a future privacy-reviewed random device identifier in the encrypted Companion projection.

## Testing

Key-vault coverage proves normalization finds but does not erase an older pairing. Controller coverage proves Platform revocation precedes local key release and the published selector retains only the current pairing.
