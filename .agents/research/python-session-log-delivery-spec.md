# Packaged Python session-log delivery specification

Issue #604 is the independently authorized prerequisite for completing Issue #602 and PR #603. The user authorized diagnosis and a reviewed minimal root-cause repair; no release, deployment, credential copying, test weakening, or further blind queue retry is authorized.

## Baseline and observed failure

The independent specification branch is `codex/feature-python-session-log`, based on master `6d3b7a9d923f5d1fc7bcd3a2d89bcca942bdb522`. Keep the guidance delivery branch and its reviewed tree unchanged while diagnosing this issue.

Merge-group run `33953482097`, candidate `d247f8529aa365c5399f288c7020cf794a91555d`, failed Python runtime job `101272697419`. The MCP smoke completed the expected final response and discovery/tool-call sequence, then found no `*.jsonl` session log. The assertion is after the `DeepSeekHarness` context exits; the generated MCP configuration explicitly sets compression to `none`. All other selected lanes passed on that candidate. Passing previous runs establish an intermittent observation, not its cause.

## Diagnostic acceptance

1. Reproduce the failure with a keyless, bounded probe, or provide a deterministic negative control at the actual owning lifecycle relationship. Record the command, output, relevant process exit status, and expected persisted artifact.
2. Distinguish successful shutdown acknowledgement, completion of server-owned teardown, completion of root disposal, normal process exit, and SDK forced termination. Do not equate them.
3. Check the source-level hypothesis that the Python SDK can terminate a still-running process immediately after the shutdown response, while Node root disposal happens after that response. Confirm or reject it with execution evidence before selecting the fix.
4. Report residual uncertainty: demonstrating a possible race does not prove every CI occurrence had that cause without adequate evidence. Do not label the failure a harmless flake or add a filesystem poll merely because a prior run passed.

## Repair and verification acceptance

- Change only the owner justified by the diagnostic evidence. Preserve the public timeout configuration and bounded terminate/kill fallback; do not introduce an unbounded wait or weaken the JSONL assertion.
- Add failing-then-passing regression coverage for acknowledged shutdown followed by delayed, bounded persistence/disposal. Preserve coverage for a bridge that never acknowledges shutdown or ignores termination, and ensure processes and reader threads are reaped.
- Run the relevant Python client/API tests and applicable real-composition keyless runtime smoke. Explain which artifact/source launch is tested; no real-model service or user credential copy is needed for the existing keyless fixture server.
- Follow repository lifecycle, architecture, Agent Note, documentation, bilingual pairing, and required assembled evidence rules. Keep source/config changes within the accepted repair scope, and retain exact check outcomes rather than replacing failures with generic success claims.
- Publish one independently reviewed specification PR for this repair. The coordinator assigns writers and a merger; the writer does not change the guidance PR or merge master. Record final writer retrospective candidates and obtain user keep/drop decisions before landing additional environment changes.
- Satisfy PR-head checks and then the merge-queue candidate checks, without bypass. After the repair merges, refresh the guidance delivery against the verified master, revalidate affected evidence, and complete PR #603 through the normal queue. A new validated repair is not another blind retry of the unchanged failing candidate.

## Preservation and cleanup

Keep the original user checkout, untracked reports, local overrides, all unrelated worktrees and stashes, and the guidance writer's unique merge history. Diagnostic logs and probes remain in genuinely ignored scratch or system temporary directories, never in the published patch. Delete only exact clean, merged, replaceable delivery resources after GitHub confirms their result; otherwise retain them with a reason.
