# Agent Note: Project live Sessions as bounded replacements

Status: implemented

English | [中文](2026-08-24-companion-live-session-projection.zh.md)

## Problem

The authenticated Companion product could load a Desktop-authoritative Session and refresh after a Mobile mutation, but an agent could continue producing committed output without another Mobile operation. The open transcript and hidden Session list therefore became stale until manual refresh or reconnect. Forwarding the raw Host event stream would expose process-local envelopes, require Mobile to reconstruct Host projections, and create an unbounded replay and compatibility surface.

## Decision

Encrypted Companion Protocol major 4 adds a pairing-scoped `observe-session` operation and an unsolicited `session-live` replacement. Each authenticated Mobile attachment observes at most one open Session. Desktop reads the current authoritative Host Session list and Workspace list for every changed Session, and reads bounded Session history only when that Session is open for the pairing. Hidden Session replacements contain only the summary, zero-based position, and Workspace memberships. A missing authoritative Session produces an explicit removal. The protocol never forwards a raw Host event or a hidden transcript.

Desktop subscribes to the Host mux and Session WebSocket streams owned by the current loopback Host. Authoritative Host events trigger projection; model-visible `assistant/chunk` text is read only after it is present in durable Session history. Re-reading history keeps model-visible output reconstructable from the Session log rather than treating the transport frame as authority. Host replacement aborts both streams before installing their successor. Stream closure, invalid Host data, projection failure, or queue overflow retires the affected authenticated channel and asks the existing Relay lifecycle to reconnect.

One pairing-scoped source coalesces repeated changes by Session. Each attachment has a bounded queue of 32 distinct Sessions and one serialized Snow sender shared with operation results and foreground synchronization. The Desktop revision is allocated at encrypted send time and remains monotonic even when a failed send leaves a gap. Mobile accepts a live replacement only for the current physical generation and a strictly higher revision. It ignores duplicates, replaces one Session atomically, and queues at most 32 distinct Sessions while the paged baseline is incomplete. A new generation always starts with foreground synchronization and a complete authoritative baseline; transport events are not replayed.

Opening or closing the Mobile Session view sends the observation change. Previously authenticated content can remain visible while disconnected, but no observation crosses attachment replacement. Disconnect, background, pairing removal, Host replacement, or shutdown clears observers, pending projection work, WebSocket listeners, and abort controllers before releasing owned channels. Shutdown drains already-started ordered sends without accepting new work.

## Verification

Protocol tests pin major negotiation, strict `observe-session` and `session-live` codecs, older-major rejection, limits, removal fields, and revision fields. Desktop and Mobile unit tests pin open-versus-hidden projection, coalescing, generation replacement, teardown, duplicate revisions, bounded baseline merging, and shared-component observation lifecycle. The assembled test starts real Host Session persistence and HTTP/WebSocket streams, establishes the production Snow owner, appends logged assistant chunks, and observes the Mobile shared conversation and hidden list change without another refresh operation. The keyless bundled Mobile build-and-preview snapshot shows the same visible transition outside ports 5173 and 5174.

## Alternatives considered

**Poll or refresh after every visible interval.** Rejected because it adds idle traffic and still leaves an unbounded stale interval between polls.

**Forward raw Host events.** Rejected because Host events are not the Mobile presentation protocol, hidden Sessions must not receive transcript bytes, and transport delivery is not application authority.

**Send every full transcript.** Rejected because hidden Sessions need only bounded list state and a growing transcript would consume the interactive channel's fixed application ceiling.

**Persist and replay live transport frames.** Rejected because durable Session history already owns output. Reconnect obtains a new authoritative baseline and revisions provide connection-local idempotency.

## Consequences

An authenticated foreground Mobile view follows logged Desktop output without manual refresh, and its hidden Session list follows bounded authoritative summaries. The mechanism intentionally provides no background notification delivery and does not keep Mobile connected while backgrounded. A Host or projection failure temporarily trades liveness for an explicit channel reconnect and full resynchronization. Companion major 3 remains the immediately preceding safe version but cannot use live projection.
