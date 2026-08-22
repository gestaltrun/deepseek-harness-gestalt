# Agent Note: Bind paired-device presentation to Mobile Installation identity

Status: implemented

English | [中文](2026-08-22-authenticated-mobile-installation-camera-pairing.zh.md)

## Problem

Personal Pairing accepted a phone name and platform in the completion request even though Platform authenticated only the Installation id and kind. A Mobile caller could therefore choose the device presentation shown by Desktop Settings independently of its Account Session. The Mobile page also delegated QR capture to an optional window hook, so the shipped Web entry had no camera flow and could not distinguish unsupported camera APIs from denied permission.

## Decision

Mobile begins a Login Attempt with a bounded name and iOS or Android platform read from the Capacitor Device adapter. Platform persists that presentation with the Login Attempt and Account Session, and `currentInstallation()` returns it only for an authenticated Mobile Installation. Personal Pairing removes device metadata from its completion request and copies the authenticated Installation presentation into pending and confirmed pairing records. A Mobile Relay credential is bound to that pairing by a content-free fingerprint. Each authenticated attachment owns an expiring connection-token lease; close removes only its token, process loss expires, and current presence is true while any lease remains. Authenticated attach, heartbeat, and ciphertext access advance `lastAccessAt`. Desktop Settings reads these authoritative fields and renders the name, platform, pairing time, current presence, and last access. Two Mobile Installations keep separate records and either pairing can be revoked without changing the other.

The Mobile page scans QR codes through browser `getUserMedia` and the maintained ZXing browser decoder. It displays the live camera preview, prefers the environment-facing camera, and races cancellation against pending camera permission. Success, failure, cancellation, or unmount stops the decoder retry scheduler and every current or late media track. Unsupported APIs, permission denial, missing cameras, empty QR results, and malformed complete links become visible pairing errors. Camera and paste values both enter `parsePairingInvitationLink()` before the same handshake path; no short code or QR-specific invitation parser exists.

## Alternatives considered

**Keep device metadata in the pairing request and sign it with the Installation key.** Rejected because the Account provider already owns authenticated Installation projection. Repeating identity fields in a later operation creates two authorities and permits them to drift.

**Keep a native scanner hook.** Rejected because the bundled Web entry could render a scan button without any implementation. Browser media capture plus a browser QR decoder gives the product page one observable permission and cleanup lifecycle across Capacitor WebViews and ordinary secure browser contexts.

**Use `BarcodeDetector` without a decoder dependency.** Rejected because that experimental API is unavailable in major browsers used by the Mobile product. ZXing uses the established browser media APIs while retaining one bounded decoding dependency.

## Consequences

Mobile sign-in fails before OAuth traffic when Device information cannot identify an iOS or Android Installation or when its name is invalid. Existing Mobile Account Sessions without persisted presentation pass PostgreSQL parsing, then Account core revokes them after proof verification and returns `SESSION_REVOKED`; the client clears local authorization and a new login records the native presentation. Completion replay retains a SHA-256 commitment to the authenticated Account, Mobile Installation, complete invitation, and Mobile handshake, so an id collision cannot substitute any of those values. Pairing transaction format version 1 records that commitment; unversioned records without it lose replay authority while confirmed pairings and cleanup ownership survive migration. Unpair attempts every owned cleanup and aggregates failures, publishing ready only when all succeed and otherwise retaining an explicit reported failure. Account activation awaits prior Companion release and Relay revocation. Product Mobile adds `@capacitor/device` and `@zxing/browser`; camera access requires a secure context and user permission. The shipped entry renders no fixed Desktop identity or local Session before an authenticated Desktop resync. Keyless Loader snapshots remain development evidence and are not product-path acceptance.
