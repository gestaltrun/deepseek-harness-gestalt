# IM account takeover ticket graph

The specification publishes blocker-first tickets. Every implementation ticket starts from the fixed snapshot recorded in the specification after B0 verifies the source interfaces.

## Dependency graph

```text
B0 Fixed-snapshot interface and platform gap review
├── T1 IM domain configuration, accounts, and routing
├── T2 Message history, cursor progress, and reliable outbound delivery
└── T7 GUI account, workspace, and sidebar seams

T1
├── T3 DingTalk DWS adapter
├── T4 Wangwang adapter
└── T6 Simulation workspace target gating

T2
├── T3 DingTalk DWS adapter
├── T4 Wangwang adapter
└── T5 Execution coordination, triggers, and IM tools

T5
└── T6 Simulation transport and simulation tools

T3 + T4 + T5 + T6 + T7
└── T8 Assembled acceptance and keyless snapshots
```

## Tickets

### B0 — Review fixed-snapshot interfaces and platform gaps

Materialize or receive a readable checkout of `96d33581128676a469a1587ea85e0339e4853cf0`, then verify the Session event, Agent inbox/steer, tools, subagent, approval, credentials, storage, workspace, settings, and Better Sidebar interfaces used by the scheme. Record the legal environment used for source review. Confirm DWS command availability and Wangwang identity gaps without real sends or credential disclosure.

**Acceptance:** a fixed-snapshot review names every accepted interface and every remaining platform gap; no implementation ticket starts without it.

### T1 — IM domain configuration, accounts, and routing

Add durable account metadata, credential references, route rules, account pause, target resolution, and workspace binding semantics. Cover all/specific selection, specific-rule precedence, disabled-specific retention, and unconfigured no-trigger behavior.

**Acceptance:** focused domain tests cover rule resolution and state transitions, including an all rule matching a conversation that appears after the rule is saved and a disabled specific rule retaining its binding; account-level pause leaves simulation instances and manual DSH sending unaffected; a keyless assembled configuration path persists and reloads the same rules.

### T2 — Message history, cursor progress, and reliable outbound delivery

Add normalized inbound and outbound records, sender classification evidence, cursor progress, history query, outbound evidence, receipts, and result-unknown handling. Separate received, submitted, and externally sent progress.

**Acceptance:** domain tests cover deduplication, ordering, replay, unknown result handling, and history query boundaries, including disabling a conversation suppressing its pending AI outbound sends without replaying them on re-enable; a keyless snapshot proves the model-visible classification and query result shape.

### T3 — DingTalk DWS adapter

Adapt the delivery contract to the installed DWS public commands for user/group subscriptions, history, send, reply, and send status. Use dry-run/mock fixtures for automated evidence and keep live sends out of ordinary checks.

**Acceptance:** adapter tests cover command composition, malformed output, event identity, history pagination, and result-unknown mapping without real network delivery.

### T4 — Wangwang adapter

Adapt the reviewed endpoint/key authentication, event pull, cursor, producer identity, receipt, and history mechanisms while omitting Travel-Team merchant business orchestration. Merchant identity uses configured material; no whoami behavior is claimed.

**Acceptance:** adapter tests cover credential-reference use, event normalization, cursor rejection, sender classification, producer receipts, and history pagination with local fixtures.

### T5 — Execution coordination, triggers, and IM tools

Route admitted messages into the target workspace as reconstructable model-visible input, apply group trigger rules, use nearest-safe-step preemption, and register the IM outbound and history tools through the reviewed tool seam. Delegate long-running work through existing subagent capabilities without changing the agent loop.

**Acceptance:** focused tests cover trigger progress, overlap deduplication, preemption at a safe step boundary, no tool cancellation, permission/approval routing, and model-visible session reconstruction; a keyless assembled snapshot proves the admitted-message flow.

### T6 — Simulation transport and workspace tool gating

Add the simulation adapter, workspace-selected target gate, instance identity, member and managed-account injection, local bidirectional delivery, JSONL background history, concurrent instance isolation, and terminal stop semantics.

**Acceptance:** focused tests cover tool absence before configuration, fixed creation target after configuration changes, per-instance isolation, explicit stop, JSONL query-only history, rejection of any real-channel delivery, and account-level pause leaving simulation delivery unaffected; a keyless assembled snapshot proves a two-session simulated exchange.

### T7 — Account, workspace, and Sidebar GUI

Implement the accepted account settings flow, workspace navigation sections for takeover and simulation, and the Better Sidebar conversation view. Keep native approval UI as the only approval surface and avoid a separate operations board.

**Acceptance:** focused client tests cover route editing, simulation target selection, sender badges, delivery states, manual send, and both-session navigation; the GUI experience route runs headlessly against the accepted prototype's states.

### T8 — Assembled acceptance and keyless snapshots

Assemble the configured account, route, real adapter fixture, simulated user, tested agent, and Sidebar view through the real product composition. Keep real model calls, real account reads, and real outbound delivery behind separate authorization.

**Acceptance:** the keyless assembled scenario proves routing, triggers, sender classification, real/simulated path parity, stopping, and GUI presentation; the report names every external behavior intentionally left to a separately authorized live lane.
