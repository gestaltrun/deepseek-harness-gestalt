# Agent Note: IM account takeover through workspace agents

Status: proposed

English | [中文](2026-09-07-im-account-takeover.zh.md)

## Problem

DeepSeek Harness needs to receive IM messages with a real authorized account, route them to the workspace whose prompt, skills, and permissions govern the receiving agent, and let the owner inspect and validate that configuration before enabling live handling. The work crosses durable routing, platform transport, replayable agent input, tool authorization, and GUI presentation. Existing references prove parts of the behavior but do not supply a shippable boundary: the DingTalk reference project validates a DWS workflow but is used only as a mechanism reference; the Wangwang reference proves cursor advancement and outbound evidence but is coupled to merchant business logic; the DSH seams they must join are still being migrated by the upstream synchronization branch.

## Proposal

Add an IM domain whose small interfaces hide platform differences, routing, cursor progress, reliable outbound delivery, and simulated delivery. Real and simulated channels are adapters behind the same message input and outbound tool path. The first platforms are DingTalk through DWS and Wangwang through the reviewed internal OpenAPI. Feishu is out of scope: no placeholder driver, no settings flow, and no UI promise.

The specification starts from the fixed synchronization snapshot `96d33581128676a469a1587ea85e0339e4853cf0`, not from `master` and not from a moving branch head. The snapshot's source interfaces have not been reviewed in a safe readable checkout, so this proposal names conceptual roles and records that review as the first blocker instead of presenting installed-version APIs as verified facts.

The full scheme source and review pack live in [the durable design archive](../../../design/im-takeover/README.md). The accepted high-fidelity prototype and selected example-only screenshots are archived there without private GUI reference captures.

### Scope and authority

- Account connection is configured in the existing Settings surface; each platform keeps its own flow. Credentials stay behind the credential seam and never enter session logs, ordinary configuration records, screenshots, or notifications.
- Routing is configured in the workspace settings surface. A rule selects an account, direct messages or groups, and either all conversations or explicit targets. An all rule matches conversations that appear after the rule is saved. A specific rule wins over an all rule, disabling a specific rule retains its binding instead of falling back, and binding does not enable handling.
- Group triggers are multi-select: mentioned, every N new messages, and a fixed interval when new messages exist. The scheme adopts OR semantics, one submission for an overlapping batch, counting from messages not yet submitted to the agent, a fixed interval that new messages do not postpone, and progress advancement only after successful submission.
- A new trigger takes precedence at the nearest safe step boundary. It does not interrupt model generation forcibly and does not cancel a tool execution that has already started.
- Human messages from the native IM client or from DSH are marked distinctly. External IM text never authorizes an action, and approvals remain only in the native DSH approval surface.
- A simulated user agent receives simulation tools only after its workspace selects an already configured takeover target. One simulated user session owns one simulation instance; independent simulated user sessions may run concurrently. An instance keeps the target selected at creation even after the workspace configuration changes, and an explicitly stopped instance cannot revive.
- Restart behavior follows the ordinary Session default. The IM domain adds no custom interrupted-work recovery and does not force a stopped simulation to continue. Disabling live handling suppresses pending AI outbound sends without replaying them on re-enable; account-level pause affects neither manual sending from DSH nor simulation instances.

### Module roles

- **Account and identity module** — owns platform-specific connection flows, credential references, connection status, and identity evidence completeness.
- **Route and trigger module** — owns rule resolution, account-level pause, workspace target resolution, and group trigger progress.
- **Message delivery module** — owns inbound ordering and deduplication, the received/submitted/sent progress split, history queries, outbound evidence, receipts, and result-unknown handling.
- **Execution coordination module** — turns admitted messages into reconstructable model-visible input in the target workspace and delegates long-running work through existing subagent capabilities without changing the agent loop.
- **Simulation transport and tools module** — owns local bidirectional delivery, fixed instance identity, member selection, JSONL background history, and instance stop semantics. Simulation replaces only IM delivery; other tools keep their own behavior.
- **UI consumers** — mount account settings, workspace settings, and the Better Sidebar conversation view using the accepted prototype as the visual source.

### Platform evidence

DingTalk evidence comes from the installed DWS CLI and the HiQ reference implementation's behavior, not from copying its code. The installed CLI exposes user authentication status, user/group event schemas, message history, send, reply, send-status query, and dry-run subscription commands. HiQ uses older internal command aliases, so the adapter contract must target the installed public commands instead.

Wangwang evidence comes from the Travel-Team implementation: endpoint/access-key/secret-key configuration, event pull and cursor advancement, source and sender validation, producer identity, outbound receipts, and history listing. Its OpenAPI contract has no whoami operation, so merchant identity comes from configured identity material rather than discovery after credential validation.

## Alternatives considered

**Wait for the synchronization branch to merge into `master` first.** Rejected because the user selected the synchronization snapshot as the planning base. The proposal freezes an exact commit and leaves interface review as the first blocker instead of tracking a moving upstream head.

**Copy the HiQ reference project as the base implementation.** Rejected because its current command aliases differ from the installed DWS CLI, its source is bundled JavaScript rather than a maintainable package structure, and the user narrowed its role to mechanism reference and bug comparison.

**Add a simulation-only reply path beside the real IM tool.** Rejected because it would let a configuration pass simulation while failing the real path. The tested agent uses the same input and outbound tool path; the instance context selects the simulation adapter.

**Give IM its own approval or interruption channel.** Rejected because native DSH approval owns authorization, and the user selected nearest-safe-step preemption rather than forced cancellation.

## Acceptance criteria

- The fixed snapshot is published or materialized for review, and the first blocker records the exact source interfaces that remain unchecked.
- The specification branch carries this proposed note, the specification, the ticket dependency graph, the experience route, and the sanitized durable design archive.
- The tracker contains one specification and blocker-first tickets, each with its own observable acceptance and focused keyless evidence requirement.
- Real outbound delivery, real model calls, and real account reads remain outside ticket evidence unless separately authorized.
- No implementation writer starts from this proposal before the fixed-interface blocker is resolved.

## Risks

- The review branch of the specification pull request descends from `origin/master` and does not contain the fixed snapshot; the snapshot is currently reachable through the ancestry of the previously published head `c2914ed9a5b3a8d51b2c0800d383376705e0da81` or the local preserved ref `codex/im-takeover-preserved-6d911d`. After the lease update, `c2914ed9` has no branch reference and GitHub does not guarantee retention of unreferenced commits, so the synchronization project must publish the fixed baseline officially before implementation; that publication is an implementation prerequisite, not a blocker for this specification delivery. The remaining blocker for implementation is source-interface and check review at the fixed snapshot.
- Installed-version Session, Agent, tools, subagent, settings, workspace, and Sidebar APIs cannot prove compatibility with the fixed snapshot.
- DWS real sending, sender evidence, and receipt semantics have dry-run and schema evidence but no authorized live-message test.
- Wangwang cannot currently prove merchant identity from credentials because the reviewed OpenAPI surface has no whoami operation.
- The accepted UI archive retains historical Feishu and trigger-review content; its archive README records the later scope overrides, but implementation must follow this proposal rather than stale prototype text.
