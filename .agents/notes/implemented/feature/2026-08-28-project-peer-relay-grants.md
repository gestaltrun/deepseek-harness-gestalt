# Agent Note: Project peer relay grants issue sealed per-peer route credentials

Status: implemented

English | [中文](2026-08-28-project-peer-relay-grants.zh.md)

## Problem

Member questions must travel end-to-end encrypted between Desktop installations of *different* accounts, but the only route authority a member's installation could obtain was bound to Personal Pairing, whose authorization chain assumes the two endpoints resolved to one Account through one handshake. Issuing a credential for member B on member A's route had no seam: the relay route store already accepted arbitrary endpoint digests, yet no surface proved B's project membership, produced a sealed envelope, persisted the grant, or tombstoned it when membership ended.

## Decision

`remote-access` grows a `projectPeerGrant` surface beside Personal Pairing on the same provider, composition-injected through `PersonalPairingProviderOptions.projectPeerGrants` (store, membership authority, sealer). The membership proof source is the Project Membership capability's own `roster` read, consumed through a structural local interface — a read that already rejects non-member readers, so both the grantor's and the peer's membership are proven by one existing operation and no new authentication family or membership query enters the protocol.

The grantor's provider generates a canonical P-256 Relay credential, registers only its 32-byte SHA-256 public-key digest under a per-grant selector at the carried route revision (`registerCredentialDigest`, which adds authority without replacing the route's endpoint slot), and persists a record holding the digest, the sealed envelope from the composed `ProjectPeerGrantSealer`, and revocation state. The sealer is mandatory: without a composed sealer the surface fails closed, and the sealed envelope is the only credential form the platform stores or returns. Retrieval re-proves the reader's membership and first reconciles the project's live grants — a grant whose grantor lost membership, whose peer lost membership, or whose carrying route is gone enters the revocation tombstone via the same compensating digest revocation an explicit revoke uses; an interrupted rotation repairs its superseded digest there too. Re-granting one peer installation is rotation: the replacement digest is issued before the superseded one is revoked, so the channel never drops below one valid credential.

Peer visibility needed one relay seam: `relayReady` now treats a selector-less attachment as route-owner authority that channel-scoped attachments at the same revision can also see. The grantor's own attachment carries no selector; the peer's carries the grant selector, so both directions project while different grants stay isolated. Existing selector pairing is unchanged because personal-pairing routes hold only selector-scoped credentials and keyless routes hold only selector-less ones.

## Alternatives considered

**A distinct endpoint kind for peers.** Rejected: `RelayAttachMessage.endpoint` is a closed two-value protocol union, and widening it touches the wire format, every route store, and the attach challenge transcript for what is a routing slot, not an authentication fact.

**Rotating through `activateCredentialDigest` (slot-wide replace).** Rejected: `rotate` replaces every authority on the endpoint side, so rotating one grant on a shared route would revoke the personal pairing's Mobile credential and any other grants.

**Event-driven revocation off `project-membership/roster-invalidated`.** Rejected for this change: subscribing would couple remote-access to the membership package's event contract, while the ticket's scope is the issuance mechanism and storage face. Reconciliation through the injected roster read revokes on the next grant-surface operation with the same tombstone result; production wiring that revokes at removal time rides the registry transport below.

**Platform-issued plaintext credentials (the pre-endpoint issuance flow).** Rejected: the repo deliberately removed Platform credential issuance; even a dev-state surface that stores or returns bearer credentials in the clear would widen the trust the endpoint flow exists to bound.

## Consequences

Delivery in this change stops at the sealed envelope plus durable record: opening the envelope on the peer's installation and the cross-machine transport that carries it depend on a project registry transport that does not exist yet, so member-question delivery assembles in keyless controller scenarios only, and production sealing stays behind the already-recorded independent encryption review. Revocation is eventual through the grant surface (prompt on any grant, retrieval, list, or revoke operation) rather than synchronous with membership removal. The canonical credential being a full P-256 key with only its 32-byte digest persisted is what lets the issued grant attach through the unmodified attach challenge flow; a literal 32-byte secret could not sign one. `apps/platform`'s full-package face carries a pre-existing `pairing-state-codec.ts` strictness error unrelated to this change; the affected consumer faces (`remote-access-http`, `remote-access-client`, `remote-attachments`, `apps/mobile`) and the `remote-access` face compile clean.
