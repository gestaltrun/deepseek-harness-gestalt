# @deepseek-ai/dsh-member-question-receiver

English | [中文](README.zh.md)

Host-owned Service Definition, file Provider, and authenticated-ingress Consumer adapter for member-question receiving state. `ctx.memberQuestionReceiver` owns arrival, Host Session materialization, route threads, terminal projection, expiry, and explicit human-turn admission. Arrival creates one Host Session in the invitation-bound Workspace and injects the Decision Brief without spending model tokens.

## Service: `MemberQuestionReceiverService` (ctx key: `memberQuestionReceiver`)

### Public API

- `ingest(envelope)` accepts a decoded `member-question` operation only beside the receiver Account authority established by the authenticated endpoint. Optional `documents` carry transferred bytes correlated by reference path after `MemberQuestionDocumentAssembler` reconstructs Companion `document-chunk` frames. Replay of the same question is idempotent; conflicting authority or content fails. The Host creates and persists an opaque `ReceivingSessionId` for `(originSessionId, receiver Account)`, then calls the injected Session materializer so that identity becomes the ordinary Host Session in the invitation-bound Workspace. The materializer writes transferred bytes under `.dsh/member-questions/<questionId>/` through an exclusive owner-only create after unlinking a planted symlink, and returns `{ path, reason, cachedPath }` metadata; a same-named Workspace file is never replaced. It never derives an id from `mq-recv` or trusts an addressee inside plaintext.
- `snapshot()` returns the complete committed revision with pending questions and terminal records. `changes(listener)` publishes the same authoritative projection only after atomic durable replacement; one throwing listener cannot starve another.
- `settle(questionId, settlement)` proposes an explicit `answered` or `declined` terminal through the configured first-claim authority, or applies an authoritative transport claim. The retained terminal is canonical, including a losing local claim; human terminals retain typed Installation id, device name, time, and any answered values, while `expired`, `withdrawn`, and `superseded` remain system terminals.
- `admitHumanTurn({ receivingSessionId, revision, rpcId, content, mode })` reserves the stable `rpcId`, normalized content, mode, and digest durably, projects that reserved id and mode for Client restart, resolves the exact bound Workspace id into the admission context, calls one injected high-level human-turn adapter, and commits after success. The adapter does not query the receiver service while its transaction is active. A failed adapter or post-admission file commit leaves the exact action retryable; replay under the same `rpcId` rejects different content. The adapter must be idempotent by `rpcId`; callers never receive separate Session-create and prompt operations.
- `bind(accountId, projectId, workspaceId)`, `lookup(accountId, projectId)`, `bindIfCurrent(accountId, projectId, expectedWorkspaceId, workspaceId)`, and `resolve(accountId, projectId)` own the exact local Workspace association selected during invitation acceptance. `lookup` distinguishes an unbound pair from an existing exact selection without replacing it; `bindIfCurrent` gives Host recovery an atomic comparison point; `resolve` fails when no selection exists. The same file Provider is exposed as `ctx.memberQuestionWorkspaceBinding`; replacement and restart preserve the opaque Workspace id.
- `createAuthenticatedMemberQuestionIngress(receiver)` is the package-folded Consumer adapter for a future authenticated endpoint. It accepts only an `AuthenticatedMemberQuestionEnvelope`; authentication remains the endpoint's responsibility.
- `registerTerminalAuthority(authority)` installs the single first-claim adapter used by this Host, matching `registerSessionMaterializer` and `registerHumanTurnAdmitter`.

## Persistence and ordering

The Provider writes one owner-only JSON document at `<storagePath>/<environment>/member-question-receiver.json` through random-sibling atomic replacement. Pre-release format version `1` stores bounded origin, background, question/options, reference path/reason metadata, receiver-owned `cachedPath` values, route identity, terminal metadata, exact Account/Project Workspace bindings, and each reserved human action as text plus durable attachment references under a SHA-256 request digest. Referenced document bodies and raw browser image bytes remain outside this ledger; transferred copies live under the bound Workspace at `.dsh/member-questions/<questionId>/`.

One serialized transaction owner orders load, arrival, terminal publication, file commit, admission reservation, materialization, and admission commit. A newer same-route ask becomes pending only after the previous pending ask's canonical `superseded` or already-due `expired` terminal commits. The one earliest-deadline scheduler claims and persists expiry; publication failure retries after `terminalRetryMs`. Startup settles overdue rows before reads become available, so restart cannot revive an expired card. Disposal clears timers and listeners, waits for the transaction tail, and retains the ledger.

## Configuration

- `storagePath` — non-empty root directory for receiver ledgers.
- `environment` — `development` or `production`; each has an independent document namespace.
- `maxRecords` — positive durable question-record ceiling. Exhaustion fails arrival rather than deleting terminal history.
- `terminalRetryMs` — positive retry delay after an authoritative expiry publication fails.
- `terminalAuthorityMode` — `deferred` keeps settlement fail-closed without a transport authority; `development-local` enables a keyless single-Host authority only when `environment` is `development`.
- `terminalAuthority` — optional first-claim adapter. Arrival remains available without it, while any transition requiring publication fails closed.
- `materializer` — optional high-level Host Session adapter. Arrival still records the question when absent, but Host Session creation remains reserved until a materializer is registered and resumed.
- `admitter` — optional high-level human-turn adapter. Human-turn admission fails closed when absent.
- `clock`, `timer`, and `stateWriter` — injected time, scheduling, and atomic-storage faces used by deterministic compositions and storage-boundary tests; production uses the system clock/timer and owner-only atomic replacement.

## Model Experience

None, as authenticated arrival, receiver projection, terminal settlement, and reservation bookkeeping do not enter a model request; only a later explicit human turn reaches the ordinary Host admission adapter.

#### KV Cache effect

Arrival and terminal browsing have no token cost or cache invalidation. The Host materializer injects each bounded brief before any human prompt; the Host admission adapter produces one ordinary Session request only after explicit human submission.

## Known Limitations and Deferred Work

- **Arrival and admission require the invitation-time local Workspace binding** — the Host resolves the receiver Account and Project only through the persisted exact Workspace id. A missing or deleted association fails Session materialization and the human-turn RPC without exposing Session creation or prompt compensation to the Client.
- **Cross-machine terminal authority remains injected** — real multi-Installation first-claim publication depends on the project-registry transport. A composition without that authority can retain future pending arrivals but fails closed before decline, expiry, or supersession.
- **Document reassembly is a consumer of T4 frames** — `MemberQuestionDocumentAssembler` validates ordering, duplicate identity, and the 8 MiB cumulative budget after the codec has already admitted each independent `document-chunk`.
