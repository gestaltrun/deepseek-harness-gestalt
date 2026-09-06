# IM account takeover specification

## Problem statement

DeepSeek Harness users need real IM conversations to become governed workspace work without turning the product into a platform bot. An authorized DingTalk or Wangwang account receives messages, DSH routes an admitted message to the workspace selected for that conversation, and the workspace's prompt, skills, permissions, and approval policy govern the receiving agent. Before live handling is enabled, a separate simulated user agent can exercise the same message path against the same configured target without contacting the real IM account.

## Solution

Add one IM domain with a small number of deep modules. The account and identity module owns platform connection and credential references. The route and trigger module owns account-to-workspace rules and group trigger progress. The delivery module owns inbound evidence, history, cursor progress, outbound evidence, and result-unknown handling. The execution module turns an admitted message into reconstructable model-visible input. The simulation module owns local bidirectional delivery and workspace-gated simulation tools. UI consumers mount the accepted account settings, workspace settings, and Better Sidebar conversation surfaces.

The specification distinguishes two baselines. The **review baseline** is `origin/master`: this pull request branches from it, and the fixed snapshot is not its ancestor. The **implementation baseline** is fixed synchronization snapshot `96d33581128676a469a1587ea85e0339e4853cf0`, reachable through the published predecessor head `c2914ed9a5b3a8d51b2c0800d383376705e0da81` (its ancestor) or the local preserved ref `codex/im-takeover-preserved-6d911d`. The fixed snapshot's source interfaces remain unreviewed because current instructions allow DSH source inspection only in the installed application checkout. The first ticket reviews those interfaces in a safe readable materialization and blocks implementation tickets until then.

## User stories

1. As the workspace owner, I want to connect one or more accounts per supported platform, so that DSH can use the authorized identity without storing secret values in ordinary configuration.
2. As the workspace owner, I want DingTalk connection to use the installed DWS login state, so that DSH acts as the authorized employee account rather than a group bot.
3. As the workspace owner, I want Wangwang connection to use endpoint, AccessKey, and SecretKey references, so that secret material remains behind the credential seam.
4. As the workspace owner, I want connection status and credential expiry to be visible, so that I can tell whether live handling can work.
5. As the workspace owner, I want binding a conversation to a workspace to be separate from enabling handling, so that I can configure and test before live replies.
6. As the workspace owner, I want direct-message and group rules to support all or selected targets, so that DingTalk can focus on groups and Wangwang can cover merchant direct messages. An all rule matches future conversations of its type, not only the ones visible at save time.
7. As the workspace owner, I want a specific rule to win over an all rule, so that one special conversation can use a different workspace.
8. As the workspace owner, I want disabling a specific rule to retain its binding instead of falling back to the all rule, so that disabling means what it says.
9. As the workspace owner, I want an account-level pause that preserves rule state, so that I can stop one account quickly without losing configuration. The pause does not block manual sending from DSH and does not affect simulation instances.
10. As the workspace owner, I want an unmatched conversation to remain unconfigured, so that an unfamiliar conversation cannot reach a sensitive workspace by default.
11. As a group participant, I want the agent to respond according to the group's trigger settings, so that the agent is available without reacting to every unrelated message.
12. As the workspace owner, I want group triggers to combine mention, every-N-new-message, and fixed-interval conditions, so that different groups can use different rhythms.
13. As the workspace owner, I want overlapping trigger conditions to submit one batch once, so that the agent does not receive duplicate work.
14. As the workspace owner, I want a new trigger to take effect at the nearest safe step boundary while the agent is busy, so that urgent context is not delayed behind the whole current turn.
15. As the workspace owner, I want that preemption not to cancel an already running tool, so that in-flight work remains safe.
16. As the workspace owner, I want human messages from the native IM client and from DSH to be marked distinctly, so that the agent can follow workspace policy without a forced takeover lock.
17. As the workspace owner, I want the agent to see AI outbound echoes as its own prior messages, so that they cannot trigger another reply loop.
18. As the workspace owner, I want unknown self-message evidence to remain unknown, so that the product does not guess whether a human or the AI sent it.
19. As a buyer or group member, I want my message to be treated as external input rather than owner authority, so that chat text cannot approve a protected action.
20. As the workspace owner, I want approvals to remain only in the DSH approval surface, so that an IM reply cannot grant permission.
21. As the workspace owner, I want to query current conversation history from the agent, so that omitted backlog remains available without forcing every old message into context.
22. As the workspace owner, I want delivery progress to distinguish received, submitted to the agent, and sent externally, so that restart recovery cannot silently repeat or lose messages.
23. As the workspace owner, I want result-unknown outbound sends to remain marked for confirmation instead of being blindly retried, so that DSH does not duplicate a message that the platform may already have accepted.
24. As the workspace owner, I want a sidebar conversation view beside the agent transcript, so that I can compare the real or simulated IM messages with the agent's work.
25. As the workspace owner, I want to send manually from DSH while automatic handling is off, so that pausing automation does not prevent me from using the authorized identity.
26. As a simulated user agent, I want my workspace to select one configured takeover target before simulation tools appear, so that simulations cannot address arbitrary accounts or conversations.
27. As a simulated user agent, I want to create a direct-message or group simulation against the selected target, so that I can test the workspace configuration without touching the real channel.
28. As a simulated user agent, I want to choose the speaking member in a simulated group, so that multi-person context can be tested.
29. As a simulated user agent, I want to inject a message from the managed account's human identity, so that human-message policy can be tested.
30. As the workspace owner, I want the tested agent to receive simulated messages in the same format and through the same tools as real messages, so that a passing simulation reflects the live path.
31. As the workspace owner, I want simulated outbound messages to return to the simulation instance, so that no test message reaches a real contact.
32. As the workspace owner, I want multiple independent simulated user sessions to test the same target concurrently, so that separate scenarios do not share conversation state.
33. As the workspace owner, I want each simulation instance to keep the target selected at creation after the workspace configuration changes, so that an in-flight test is not retargeted.
34. As the workspace owner, I want an explicitly stopped simulation to stay stopped, so that a review session cannot resume unexpectedly.
35. As the workspace owner, I want imported JSONL history to be queryable background rather than replayed input, so that historical messages cannot trigger tasks twice.
36. As a maintainer, I want the IM domain not to change the agent loop, so that channel behavior stays behind documented plugin seams.
37. As a maintainer, I want every model-visible IM input to be reconstructable from the session log, so that replay and audit retain the same facts the model saw.
38. As a maintainer, I want DingTalk and Wangwang adapters to share the delivery contract but keep platform authentication and evidence separate, so that future platform support does not require rewriting the domain.
39. As a maintainer, I want Feishu excluded from the first delivery, so that the product does not claim an unavailable login path.
40. As a reviewer, I want the accepted prototype and example-only screenshots archived with the specification, so that the visual target survives temporary files without exposing private GUI captures.

## Implementation decisions

- The delivery starts from fixed snapshot `96d33581128676a469a1587ea85e0339e4853cf0`; implementation does not chase the moving synchronization branch or `upstream/master`.
- The fixed snapshot must be published by the synchronization integrator or materialized in a safe readable checkout before implementation. Current source restrictions prevent treating installed-version APIs as fixed-snapshot facts.
- DingTalk uses DWS public commands from the installed CLI; HiQ is a mechanism reference only, and its older internal aliases are not copied.
- Wangwang uses endpoint, AccessKey, and SecretKey configuration and the reviewed cursor/producer/receipt mechanisms; merchant identity comes from configured identity material because the reviewed OpenAPI has no whoami operation.
- The agent-facing outbound tool path is shared by real and simulated deliveries. The simulation instance context selects the simulation adapter; there is no simulation-only tested-agent reply tool.
- Human native, human DSH, AI outbound, external, and unknown sender classifications carry evidence and remain distinct in model-visible input and presentation.
- Permission checks and approvals use existing DSH seams. IM text is never an approval grant.
- Group trigger progress advances only after successful submission to the agent. OR, one-batch deduplication, counting unsubmitted messages, and fixed-interval timing are scheme decisions for this specification.
- Simulation restart behavior follows ordinary Session defaults. Explicit stop is terminal for the instance. Disabling live handling stops pending AI outbound sends for that conversation without re-flushing them on re-enable, and account-level pause affects neither manual sending from DSH nor simulation instances.
- An all-scope route rule dynamically matches future conversations of its type; it is not a snapshot of the conversation list at save time.
- The first release contains no evaluation or scoring system, no independent operations board, no IM-specific approval page, and no Feishu placeholder.

## Experience route

1. Open Settings → IM Accounts and connect a DingTalk account through DWS or a Wangwang account through endpoint and key references.
2. Open Workspace Settings → IM Takeover and add or edit a route for direct messages or groups.
3. Configure group triggers with the three multi-select conditions and leave the route disabled if live handling is not ready.
4. Open Workspace Settings → IM Simulation in the simulated user's workspace and select a configured target.
5. Start a simulated user session, create a simulation, send as a member or managed-account human, and open both agent sessions.
6. Inspect the shared Sidebar conversation stream, message detail, delivery state, and sender classification.
7. Stop one simulation and confirm another instance remains unaffected.
8. Enable the real route only after the simulation demonstrates the intended workspace behavior.

## Evidence and verification policy

Each ticket owns focused tests at its seam and the smallest keyless assembled snapshot that proves its model- or user-visible output. Mock and dry-run evidence is not presented as live end-to-end evidence. Real outbound sends, real model calls, and real account reads require separate explicit authorization.

## Design references

- Proposed Agent Note: [IM account takeover through workspace agents](../../notes/proposed/feature/2026-09-07-im-account-takeover.md)
- Durable design archive: [IM account takeover design archive](README.md)
- Scheme source: [scheme-source.md](scheme-source.md)
- Human review pack: [review-pack.html](review-pack.html)
