# Agent Note: Keyless Project Members assembled acceptance

Status: implemented

English | [中文](2026-09-04-project-members-assembled-acceptance.zh.md)

## Problem

Spec #338 and ticket #345 require one feature-level assembled walk over real components: two accounts, three installations, real listeners, and every user-visible transition from bind through invite, presence, routed ask with chunked references, first-claim answer, expiry, withdrawal, supersede, and offline no-queue. Package suites and in-memory sender stubs cannot prove that Account, Project Membership HTTP, the T4 codec, the sender, the Host receiver, and Desktop Installations agree on those transitions, or that Platform retained state stays free of business plaintext.

## Decision

Assembled #345 evidence is a locally runnable SHA-256-free AES-256-GCM development broker plus a real Account and Project Membership TCP composition. `apps/desktop/tests/member-question-e2e/assembled-project-members.spec.ts` boots one local Platform, two accounts (`ada`, `grace`), and three Installation endpoints. It walks create, invite-by-login, incomplete accept-with-link remaining pending, complete accept-with-link, roster Online from live heartbeats, last-window `/v1/projects/presence/close` Offline, a routed ask carrying background plus markdown/html/arbitrary chunked bytes, receiver-owned Files-sidebar cache paths under `.dsh/member-questions/<questionId>/` with no local composer card, concurrent B1/B2 first-claim settlement including answered-elsewhere metadata, expiry, initiator withdrawal, same-route supersede, and `MEMBER_OFFLINE` with no queued delivery. Clocks and keys are the only injected nondeterminism. The broker audit and Platform membership document contain ciphertext and authority rows only.

Visible Desktop coverage is `pnpm run test:e2e-project-members-electron`. It rebuilds current source, starts three isolated Electron processes against that same local Platform, and requires a visible `DISPLAY` on Linux. `--dsh-e2e-profile` is accepted only by an explicit unpackaged `DSH_DESKTOP_E2E=1` run. Production sealing remains behind the standing independent encryption review.

The sender encodes aligned document bytes as Companion `document-chunk` frames through `deriveMemberQuestionDocumentTransferId`. The receiver's `MemberQuestionDocumentAssembler` reconstructs those frames before Host ingest writes receiver-owned cache files under `.dsh/member-questions/<questionId>/`. `apps/desktop/tests/member-question-e2e/document-chunk-reassembly.snapshot.ts` records that encode/wire/reassembly transcript against `snapshots/document-chunk-reassembly.expected.json`. The assembled walk itself records `snapshots/assembled-project-members.expected.json` for invite, last-window presence, chunked cache bytes, first-claim, later terminals, and the wire floor.

## Alternatives considered

**Treat the `examples/project-members` snapshot as sufficient.** Rejected: that composition seeds an in-memory roster and a memory sender, so it never executes Account sessions, Project Membership HTTP, presence heartbeats, or encrypted multi-installation delivery.

**Wait for operated GitHub OAuth and reviewed production encryption.** That remains the production activation path, but it is not available as the repository's keyless regression. The local Platform and ciphertext broker are the substitute, not a claim that product cryptography shipped.

**Drive the assembled walk only through Electron.** Rejected: the WDIO lane needs a display, a rebuilt Desktop, and three processes. The in-process assembled spec remains the always-runnable macOS/Linux keyless gate; Electron is the visible three-installation overlay.

**Store transferred document bodies in the receiver ledger.** Rejected: T9 already writes those bytes under a receiver-owned Workspace cache, and the ledger already excludes referenced bodies.

## Consequences

#345 can close on keyless assembled and source Electron evidence without a development Platform deployment. Operated GitHub accounts, independent encryption review, and the baseline-to-master PR remain separate evidence. The ciphertext broker and `--dsh-e2e-profile` stay off the packaged path.

## Testing

- `pnpm exec vitest run --config vitest.snapshot.config.ts apps/desktop/tests/member-question-e2e/document-chunk-reassembly.snapshot.ts`
- `pnpm exec vitest run apps/desktop/tests/member-question-e2e/assembled-project-members.spec.ts apps/desktop/tests/member-question-e2e/keyless-transport.spec.ts apps/desktop/tests/e2e-profile.spec.ts`
- `pnpm exec vitest run packages/interaction/member-question-sender/tests/document-transfer.spec.ts packages/interaction/member-question-receiver/tests/document-transfer.spec.ts packages/platform/remote-protocol/tests/companion-document-transfer.spec.ts`
- `pnpm run test:e2e-project-members-electron` on a host with a visible display

## Related

- Issue #345 (parent spec #338)
- [Project membership authority](../feature/2026-08-27-project-membership-core.md)
- [Member-question sender](../feature/2026-08-28-member-question-sender.md)
- [Host-owned receiver ledger](../architecture/2026-08-31-host-owned-member-question-receiver-ledger.md)
