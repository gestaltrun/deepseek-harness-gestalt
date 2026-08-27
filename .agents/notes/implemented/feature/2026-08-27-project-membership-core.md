# Agent Note: Project membership authority lives beside Platform identity stores

Status: implemented

English | [中文](2026-08-27-project-membership-core.zh.md)

## Problem

The collaboration spec (#338) introduces cloud projects with owner/admin/member roles, project-defined function tags, and invitations whose acceptance links a workspace atomically. Two placement questions preceded any code: whether the authoritative project/membership store belongs on the operated Platform at all — given that the [stateless two-instance Relay](../../architecture/2026-08-18-stateless-two-instance-remote-relay.md) decision deliberately keeps every Platform Instance free of DSH business values — and how presence may be derived without inventing a state model. The production story also had to avoid widening trust beyond the standing cryptographic review gate.

## Decision

Project membership is a Platform capability seam (`@deepseek-ai/dsh-project-membership` Service Definition, `@deepseek-ai/dsh-project-membership-core` file-backed provider). The registry lives on Platform because it is **authority-plane data of the same kind as Accounts, Installations, pairing authorities, and Relay route records**: rows whose whole job is to decide who may invite, join, retag, or remove whom, committed durably per environment namespace (`development`/`production`). Every mutation carries its role gate inside the operation itself, serializes through one write chain, publishes the whole document through an atomic rename, and emits a roster-invalidation record after durability so consumers rebuild cached roster views instead of trusting stale ones.

The boundary statement required by that placement: hosting durable collaboration **authority** does not turn a Platform Instance into a business-value service, and it does not erode the Relay decision. That decision's prohibition targets the **message plane** — DSH Session, prompt, approval, model, Workspace, and Companion plaintext must remain invisible to forwarding instances, and nothing queues or replays there. Membership rows are forwarding-shape-neutral: they never enter Companion protocol frames, they are not per-message state, and asking a member routes question payloads end-to-end encrypted exactly as before. The Relay credential/route machinery keeps owning attachment liveness; this capability owns only "who is reachable by role".

Presence derives solely from connection liveness: a member is online when at least one of their installations holds a live platform connection at evaluation time, and offline the moment the last one closes. There are no manual statuses, no idle inference, no grace windows, and no delivery queues — asking an offline member fails fast with a stable error rather than parking work. The trade-off is deliberate: presence answers "can I hand this person a decision right now", which liveness alone can answer honestly.

Function tags stay display-and-routing metadata owned by the project vocabulary: they ride every roster view, they are editable only by owner/admin, and they never gate a permission. Roles govern only this plane and stay disjoint from Git-provider permissions in both directions.

Production remains fail-closed behind the independent channel-encryption review recorded alongside the [versioned Remote Protocol](../../architecture/2026-08-18-versioned-remote-protocol.md): development composes and verifies through keyless assembled scenarios over local storage, while any routed-question activation in a produced deployment waits for that review to clear. Nothing in this change moves transport, credentials, or plaintext across that line.

## Supersession check

Both cross-referenced 2026-08-18 notes were audited and neither is superseded. The Relay note's guarantees (forwarding-only instances, no retained mutations, no business-value parsing) constrain a different plane than this durable authority store, and this note exists partly as the boundary explanation for that coexistence, so its full rationale stays active. The Remote Protocol note owns codec ownership, version negotiation, and the product-cryptography review gate that still binds production; this note defers to it rather than restating the gate. No active note owned project-membership semantics previously.

## Alternatives considered

**Keep membership state client-side on one trusted installation.** Rejected because two people clone the same repository onto different machines: a single-machine file cannot settle concurrent duplicate invites, survives no laptop loss, and makes removal propagation meaningless. Multi-master sync was ruled out with it — invitation acceptance needs one arbitration point, not convergence.

**Reuse the Relay route or personal-pairing stores for projects.** Rejected because those rows answer "which endpoint receives bytes" and hold sealed secrets; project rows answer "who holds which role", need different lifecycle semantics (removal, LAST_OWNER), and mixing them would blur both audits.

**Derive presence from stored activity timestamps with idle thresholds.** Rejected because heuristic presence reads as trustworthy but lies at both ends — an idle-but-connected colleague shows offline while working, and an away laptop lingers online until a timer fires. Liveness is the only state hardware already tells the truth about.

**Enable production routing now behind the existing transport.** Rejected because the standing review gate is fail-closed by design; shipping registry capability without touching transports widens no trust, which is precisely what lets this land early.

## Consequences

Duplicate invites and interleaved promote/remove settle under one serialized writer per process, proven by executor-level denial tests and a real Loader composition that boots two generations over one durable document. Removed accounts lose enumeration immediately and their leave-taking bumps the per-project roster projection version, which the package invariant companion holds strictly increasing — including removals. Environment namespacing keeps development identities from colliding with production ones even over one shared storage root. The cost of the single-process write chain is that horizontal scaling of this provider needs a backend swap with equivalent compare-and-mutate semantics, not more instances of this class; the interface stays provider-owned so that swap does not move the role gates out of the operations that enforce them.
