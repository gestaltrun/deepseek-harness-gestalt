# Agent Note: Project authoritative Session search and Host failures through Companion

Status: implemented

English | [中文](2026-08-22-companion-session-search-host-failures.zh.md)

## Problem

Mobile Companion needs to find Session content that exists only in the Paired Desktop index, and every Host refusal must remain visible after crossing the encrypted application channel. Searching the Companion Cache would make Mobile a second Session authority and miss cold content. Treating non-2xx responses, malformed JSON, business refusals, or timeouts as thrown transport errors can collapse an HTTP 400 into an empty object or silent stream loss.

## Decision

The Desktop-only composition activates `session-query-sqlite` with `openAt: first-search` and a derived index at `DSH_HOME/session-search.sqlite`; browser `dsh web` retains the repository default `openAt: never`. Companion `search-sessions` operations call the Web Host `session.search` method. Mobile renders every correlated `session-search` Session id/snippet pair directly, including hits absent from the Companion Cache, and never adds cached title, Workspace, summary, transcript, or substring matches.

The Encrypted Companion Protocol owns `operation-failed` as the lossless Host failure result. Its closed categories are HTTP status, invalid wire response, typed business error, and timeout. HTTP failures retain the numeric status, including 400; business failures retain a bounded code and message; every failure carries the originating operation id. The Desktop loopback client settles a non-2xx response as soon as its headers arrive, before response-body accumulation and the absolute wall-clock deadline can replace the known status. It validates successful RPC envelopes and echoed ids, and its configured response accumulator cannot exceed the 60 KiB Companion application-message ceiling; cumulative overflow destroys the response and becomes an invalid-wire failure. It returns values rather than throwing these expected failures. The Mobile surface accepts results only through a receiver bound to the decoder's physical connection generation. It correlates search results with the current search operation and owns exactly one unresolved attachment operation id returned by the mutation channel. A sending or uncertain attachment blocks another selection until confirmation, rejection, failure, or reconciled status releases the id; results for every other attachment id are inert. Attachment send completion can publish the uncertain state that retains the id for reconciliation. Search and attachment failures are visible alerts; disconnection, replacement, or backgrounding makes the old decoder receiver inert.

Desktop Host installs a `DesktopCompanionProductOwner` after the shipped Web Host reports its loopback origin, replaces that RPC when the Web Host restarts, and removes it before shutdown. The Desktop entry smoke creates and prompts a real Session, then requires both an indexed hit and a no-hit `session.search` through this installed owner. Source-plane Host compositions join a real Session event, SQLite provider, Host API carrier, loopback HTTP, and Desktop owner without requiring Web client build artifacts; they exercise indexed hit, no-hit, disabled, and failed providers. A bounded cross-process assembly carries a real HTTP 400 through the Desktop owner and Companion codec into the shipped Mobile entry alert. This evidence proves the shipped endpoint compositions and application projection only; the reviewed encrypted channel remains the owner of endpoint operation delivery and pairing-scoped attachment dependencies.

Search results contain at most 20 unique Session ids, each with a snippet of at most 240 Unicode code points. Queries use the Host limit of 500 UTF-16 code units. Failure messages are limited to 4,096 UTF-8 bytes. The protocol codec and Desktop adapter enforce these bounds independently so a valid Host response cannot become an oversized Encrypted Companion message.

This decision implements the Session-search and Host-failure slice of the [real Companion product path](../../proposed/architecture/2026-08-22-real-companion-product-path.md). The [pairing-scoped attachment decision](../feature/2026-08-19-encrypted-companion-attachments.md) owns attachment ciphertext and byte delivery; this note owns how Host outcomes cross the Companion application protocol.

## Alternatives considered

**Filter the Companion Cache locally and ask Desktop only for missing results.** Rejected because local substring rules differ from the SQLite provider, omit unopened or cold Sessions, and make merged ranking depend on Mobile cache history.

**Map every Host failure to one `host-rejected` reason.** Rejected because a user cannot distinguish a malformed request, disabled or failed index, broken Host response, and deadline. It also discards the HTTP status required to diagnose carrier failures.

**Tunnel the complete Host response envelope.** Rejected because the complete Host API is outside Companion Surface authority and would couple separately released Mobile versions to Host RPC fields. Companion projects only bounded search values and stable failures.

**Enable full-text search in the shared Web bundle.** Rejected because content indexing is a deployment choice. The Desktop product requires it for Companion, while browser and headless deployments retain the default-off policy.

## Consequences

Mobile search quality, visibility, and snippets come from the same Desktop authority as the Web Session search without requiring a matching cached Session. Attachment rejection, attachment Host failure, and uncertain delivery remain correlated and visible. A Host 400, malformed response, business refusal, absolute-deadline timeout, or stale decoder result remains explicit or inert instead of disappearing or mutating replacement state. Desktop pays the derived-index storage and first-search startup cost; browser `dsh web` does not. The reviewed encrypted channel still owns installation of the Mobile operation sender and generation-bound decoded-result receiver, so the shipped endpoint, protocol, and adapter evidence does not by itself prove the operated product path.
