# User Interaction

English | [中文](user-questions.zh.md)

The user-questions seam of [dsh-user-questions](../../packages/interaction/user-questions). It is the provider-neutral vocabulary a tool or permission plugin uses when it needs the human to answer before the agent can continue. UI surfaces provide the active `UserQuestionProvider`; the host runtime relays requests to its connected client. Routed asks with `to_project_member` leave this provider and travel through [`ctx.memberQuestionSender`](#ctxmemberquestionsender--memberquestionsenderservice-abstract-seam) instead.

Source: [`packages/interaction/user-questions/src/index.ts`](../../packages/interaction/user-questions/src/index.ts)

## Question options

`AskUserQuestionOption` contains one selectable choice. `label` is the user-facing option text and also the model-facing selected value; `description` is optional UI help text.

```ts type-equiv
/** One selectable answer offered to the user. */
interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}
```

## Presentation intent

`AskUserQuestionIntent` optionally declares a known decision kind. It is tagged on `kind` so intents can be added; a UI that does not recognise a tag renders the generic option list. An intent changes presentation only — a UI honouring it answers with the same option labels a generic UI would send, so the caller reads the same answer fields either way. `approve` names the affirmative option instead of relying on option order. `member-question` carries the whole routed Decision Brief of a member-directed ask from a paired installation — origin identity, agent-authored background, referenced materials, and the expiry instant. `ask()` rejects the two assertions no type can carry: an `approve` naming none of its own question's options, and an intent on a question with no `detail`.

```ts type-equiv
/**
 * A caller-declared presentation intent: the question IS this kind of
 * decision, so a UI that recognises the tag may present it as such instead of as a
 * generic option list. Tagged so further intents can be added; a UI that does
 * not know a tag renders the generic flow, and the answer encoding is identical
 * either way — an intent changes presentation only, never the protocol.
 */
type AskUserQuestionIntent =
  | {
  /** A plan submitted for review: `detail` is the plan markdown `ask()` requires, and the decision approves or declines it. */
  kind: 'plan-review'
  /**
   * The option label that approves the plan; every other option declines it.
   * Named rather than positional so no UI infers the verdict from option order.
   * An `approve` naming no option of its own question is rejected at `ask()`.
   */
  approve: string
  }
  | {
  /**
   * A question about one project member: the question IS one member-directed
   * decision routed from a paired installation, and the intent carries the
   * whole Decision Brief — origin identity, agent-authored background,
   * referenced materials, and the expiry instant — aligned field-for-field
   * with the Companion `member-question` codec bounds (T4) and the sender's
   * `MemberQuestionSendPayload` (T5). A UI that does not know the kind still
   * renders the generic option list; the answer encoding is identical either
   * way — an intent changes presentation only, never the protocol.
   */
  kind: 'member-question'
  /** Branded question identity the settlement correlates across endpoints. */
  questionId: string
  /** Originating remote session id — one half of the receiver's supersede route key. */
  originSessionId: string
  /** Account reference of the receiving member (the local user on the receiver). */
  toProjectMember: string
  /** Public origin identity rendered on the receiver's brief banner (T4 bounds). */
  origin: {
    /** Display name of the cloud project the asking workspace is bound to. */
    projectName: string
    /** One-line title of the originating session; never carries conversation content. */
    originSessionTitle: string
    /** Platform account reference of the asking member. */
    askerAccountId: string
    askerRole: 'owner' | 'admin' | 'member'
    /** Public display name shown beside the asker avatar. */
    askerDisplayName: string
    /** Avatar image URL rendered by the receiver's brief banner. */
    askerAvatarUrl: string
  }
  /** Agent-authored decision background; bounded at the sender (T4 bound). */
  background: string
  /**
   * Workspace-relative referenced documents with their rendering reasons.
   * `content` carries the inline document body for the renderable kinds
   * (`.md`/`.html`) so the receiver's document-focus panel can render the
   * referenced material without reading the asking workspace's filesystem;
   * it stays absent for kinds the panel renders as a bare file tab.
   */
  references: readonly { path: string; reason: string; content?: string }[]
  /** Epoch milliseconds after which the routed ask expires on both endpoints. */
  expiresAt: number
}
```

## Question item

`AskUserQuestionItem` is one question in a request. The caller supplies a stable `id`, which is echoed back with the answer so batched questions remain routable. Optional `detail` carries supporting text that providers render with the question but keep out of selectable option labels.

```ts type-equiv
/** One question in a user-questions request. */
interface AskUserQuestionItem {
  /** Stable caller-provided question id, echoed in the answer. */
  id: string
  /** The question to display. */
  question: string
  /** Optional supporting detail rendered with the question but kept out of option labels. */
  detail?: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional choices the UI can render as a menu. */
  options?: AskUserQuestionOption[]
  /** Whether more than one option may be selected. Defaults to single-select. */
  multiSelect?: boolean
  /** Optional presentation intent for capable UIs; absent asks for the generic option list. */
  intent?: AskUserQuestionIntent
}
```

## Ask request

`AskUserQuestionRequest` is the cross-package request. `questions` is an array so a UI can present related prompts in one flow while preserving a stable id per answer. When present, `agent` is the exact live caller; the interaction seam admits it only while the live registry identifies that instance as a runtime root.

```ts type-equiv
/** Request for a human answer. */
interface AskUserQuestionRequest {
  /** Questions to display. */
  questions: AskUserQuestionItem[]
  /** Exact live calling agent, when the request came from an agent tool call. */
  agent?: Agent
  /** Abort signal for the owning tool/step. */
  signal?: AbortSignal
}
```

## Answer

Providers return one answer item per question id. `selected` contains selected option labels, and `custom` carries a free-form "Other" answer when the user typed one. For a single-select question, `custom` overrides the selected choice and `selected` is empty. For a multi-select question, `custom` may supplement the labels in `selected`. A UI may also use an item with empty `selected` and no `custom` to preserve a skipped question in an otherwise completed batch.

```ts type-equiv
/** Answer to one question. */
interface AskUserQuestionAnswerItem {
  /** The answered question id. */
  id: string
  /** Selected option labels. May accompany custom text for a multi-select question. */
  selected: string[]
  /** Optional free-text "Other" answer. */
  custom?: string
}
```

```ts type-equiv
/** The human's answer. */
interface AskUserQuestionAnswer {
  /** Structured answers keyed by question id. */
  answers: AskUserQuestionAnswerItem[]
}
```

## Provider

Only one provider may be active in a context. Provider registration is effect-bound so HMR/disposal removes the active UI.

```ts type-equiv
/** UI-side provider for user questions. */
interface UserQuestionProvider {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}
```

## Errors

`UserQuestionError` extends `HarnessError`, so `ctx.tools.execute()` preserves `{ name, code }` for model-facing tool failures such as `EMPTY_QUESTIONS`, `NO_PROVIDER`, `ASK_ABORTED`, or UI-side cancellation.

```ts type-equiv
/** Stable error taxonomy for user-questions failures. */
class UserQuestionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserQuestionError'
  }
}
```

## Member-directed routing

`MemberQuestionSendPayload` is the application payload `ctx.memberQuestionSender.send()` encodes as a Companion `member-question` operation. Origin, questions, and references reuse the T4 Companion vocabulary; this seam does not invent a second protocol.

```ts type-equiv
/**
 * Application payload of one member-directed question. The sender encodes it
 * as a Companion `member-question` operation; origin, background, questions,
 * and references reuse the T4 codec vocabulary without a second protocol.
 */
interface MemberQuestionSendPayload {
  /** Account reference of the single addressee. */
  readonly toProjectMember: string
  /** Cloud project whose peer grant addresses that member. */
  readonly projectId: ProjectId
  /** Agent-authored background; already bounded by the asking tool. */
  readonly background: string
  /** Question batch mirrored from `ask_user_question`. */
  readonly questions: readonly MemberQuestionItem[]
  /** Workspace-validated references; an empty list is admitted. */
  readonly references: readonly MemberQuestionReference[]
  /** Public identity fields rendered on the receiver's Decision Brief. */
  readonly origin: MemberQuestionOrigin
  /** Originating session identity used as one half of the supersede route key. */
  readonly originSessionId: CompanionSessionId
}
```

`MemberQuestionSendResult` is the answered or declined settlement after the hanging `send()` promise resolves. Lifetime failures (`MEMBER_OFFLINE`, `QUESTION_EXPIRED`, `QUESTION_WITHDRAWN`, `QUESTION_SUPERSEDED`, `REVOKED_DURING_FLIGHT`) reject as `MemberQuestionSenderError` and remain ordinary tool results.

```ts type-equiv
/** Successful routed-ask settlement: the member answered the batch. */
interface MemberQuestionAnsweredResult {
  /** Branded question identity the caller correlates with later settlement. */
  readonly questionId: MemberQuestionId
  /** Companion application bytes encoded by the T4 codec. */
  readonly encoded: Uint8Array
  /** Terminal answered outcome. */
  readonly outcome: 'answered'
  /** Settling answers echoed by question id. */
  readonly answers: readonly MemberQuestionAnswer[]
}
```

```ts type-equiv
/** Successful routed-ask settlement: the member declined without answering. */
interface MemberQuestionDeclinedResult {
  /** Branded question identity the caller correlates with later settlement. */
  readonly questionId: MemberQuestionId
  /** Companion application bytes encoded by the T4 codec. */
  readonly encoded: Uint8Array
  /** Terminal declined outcome. */
  readonly outcome: 'declined'
}
```

```ts type-equiv
/** Result of one successful send: an answered or declined settlement. */
type MemberQuestionSendResult = MemberQuestionAnsweredResult | MemberQuestionDeclinedResult
```

```ts type-equiv
/** Optional session and cancellation attached to one `send()` call. */
interface MemberQuestionSendOptions {
  /** Asking session that records the durable ask/outcome pair. */
  session?: Session
  /** Aborting this signal withdraws the in-flight question. */
  signal?: AbortSignal
}
```

```ts type-equiv
/** Successful or declined settlement applied to one in-flight question. */
type MemberQuestionSettlement =
  | {
    outcome: 'answered'
    answers: readonly MemberQuestionAnswer[]
    settledByInstallationId: InstallationId
    settledByDeviceName: string
    settledAt: number
  }
  | {
    outcome: 'declined'
    settledByInstallationId: InstallationId
    settledByDeviceName: string
    settledAt: number
  }
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemberquestionreceiver--memberquestionreceiverservice-abstract-seam"></a>

### `ctx.memberQuestionReceiver` — `MemberQuestionReceiverService` (abstract seam)

Host authority for member-question arrival, Host Session materialization, projection, settlement, expiry, and one-step explicit human admission.

```ts cordis-catalog
/**
 * Persist or replay one authenticated arrival.
 * @param envelope - endpoint authority beside the decoded operation.
 * @returns Host receiving identity and committed revision.
 */
abstract ingest(envelope: AuthenticatedMemberQuestionEnvelope): Promise<MemberQuestionIngestResult>

/**
 * Read one complete committed projection.
 * @returns the complete authoritative pending and terminal projection.
 */
abstract snapshot(): Promise<MemberQuestionReceiverSnapshot>

/**
 * Subscribe to complete projections published after durable commits.
 * @param listener - projection observer; its exceptions are contained.
 * @returns disposer that removes this exact observer.
 */
abstract changes(listener: MemberQuestionReceiverListener): () => void

/**
 * Apply an explicit decline or authoritative first terminal.
 * @param questionId - routed question identity.
 * @param settlement - local decline metadata or retained global claim.
 * @returns the canonical persisted terminal.
 */
abstract settle( questionId: MemberQuestionId, settlement: MemberQuestionReceiverSettlement, ): Promise<CompanionMemberQuestionSettledResult>

/**
 * Reserve and admit one explicit human turn under one rpc id.
 * @param input - Host receiving identity, observed revision, rpc id, content, and mode.
 * @returns the durable idempotent admission result.
 */
abstract admitHumanTurn( input: AdmitMemberQuestionHumanTurnInput, ): Promise<AdmitMemberQuestionHumanTurnResult>

/** Resume every durable human action left reserved by an interrupted Host. */
abstract resumeReservedHumanTurns(): Promise<void>

/** Resume every durable Host Session materialization left reserved by an interrupted Host. */
abstract resumeReservedSessionMaterializations(): Promise<void>

/**
 * Install the single Host arrival materializer.
 * @param materializer - high-level Host Session creation adapter.
 * @returns disposer for this exact registration.
 */
abstract registerSessionMaterializer(materializer: MemberQuestionSessionMaterializer): () => void

/**
 * Install the single Host human-turn adapter.
 * @param admitter - high-level Host transaction adapter.
 * @returns disposer for this exact registration.
 */
abstract registerHumanTurnAdmitter(admitter: MemberQuestionHumanTurnAdmitter): () => void

/**
 * Persist or replace one exact Account/Project to local Workspace association.
 * @param accountId - authenticated receiving Account.
 * @param projectId - Cloud Project being joined.
 * @param workspaceId - exact local Workspace selected or cloned.
 */
abstract bind( accountId: PlatformAccountId, projectId: ProjectId, workspaceId: Branded<'WorkspaceId'>, ): Promise<void>

/**
 * Read one exact association without requiring it to exist.
 * @param accountId - authenticated receiving Account.
 * @param projectId - Cloud Project whose local association is being inspected.
 * @returns persisted local Workspace identity, or undefined before binding.
 */
abstract lookup( accountId: PlatformAccountId, projectId: ProjectId, ): Promise<Branded<'WorkspaceId'> | undefined>

/**
 * Replace one association only if its current value matches an observation.
 * @param accountId - authenticated receiving Account.
 * @param projectId - Cloud Project whose association is being repaired.
 * @param expectedWorkspaceId - observed current Workspace id, including undefined.
 * @param workspaceId - exact live replacement Workspace id.
 * @returns whether the replacement committed.
 */
abstract bindIfCurrent( accountId: PlatformAccountId, projectId: ProjectId, expectedWorkspaceId: Branded<'WorkspaceId'> | undefined, workspaceId: Branded<'WorkspaceId'>, ): Promise<boolean>

/**
 * Resolve one exact Account/Project association.
 * @param accountId - authenticated receiving Account.
 * @param projectId - Cloud Project carried by the received question.
 * @returns persisted local Workspace identity.
 */
abstract resolve( accountId: PlatformAccountId, projectId: ProjectId, ): Promise<Branded<'WorkspaceId'>>
```

Types: [CompanionMemberQuestionSettledResult](remote-protocol.md) · [PlatformAccountId](platform-account.md) · [ProjectId](project-membership.md) · [WorkspaceId](workspace.md)

Source: [`packages/interaction/member-question-receiver/src/index.ts`](../../packages/interaction/member-question-receiver/src/index.ts)

<a id="ctxmemberquestionsender--memberquestionsenderservice-abstract-seam"></a>

### `ctx.memberQuestionSender` — `MemberQuestionSenderService` (abstract seam)

Member-question sender capability. `send(payload)` encodes one Companion `member-question` operation, delivers it, and waits for a terminal settlement or a stable lifetime error.

```ts cordis-catalog
/**
 * Encode one member-directed question, deliver it, and wait for settlement.
 * @param payload - Decision Brief origin, background, question batch, and references.
 * @param options - optional asking session and withdrawal signal.
 * @returns the answered or declined settlement plus the encoded Companion bytes.
 * @throws {MemberQuestionSenderError} `DELIVERY_UNAVAILABLE` when no delivery port is composed,
 *   `GRANT_UNAVAILABLE` when a composed grant lookup cannot retrieve the peer grant,
 *   `ENCODE_FAILED` when the T4 codec rejects the payload,
 *   `MEMBER_OFFLINE` when presence is offline at send time,
 *   `QUESTION_EXPIRED` when the configured TTL elapses unanswered,
 *   `QUESTION_WITHDRAWN` when the initiator cancels the turn,
 *   `QUESTION_SUPERSEDED` when a newer same-route ask replaces this one,
 *   or `REVOKED_DURING_FLIGHT` when membership is withdrawn while waiting.
 */
abstract send( payload: MemberQuestionSendPayload, options?: MemberQuestionSendOptions, ): Promise<MemberQuestionSendResult>

/**
 * Apply one answered or declined settlement to a pending question.
 * Unknown or already-settled question ids are ignored (idempotent).
 * @param questionId - branded question identity returned by `send()`.
 * @param settlement - answered answers or a declined verdict with the settling Installation metadata and epoch.
 * @returns fulfillment after the matching `send()` promise settles, or immediately when none is pending.
 */
abstract settle(questionId: MemberQuestionId, settlement: MemberQuestionSettlement): Promise<void>

/**
 * Withdraw one pending question as initiator cancellation.
 * Unknown or already-settled question ids are ignored.
 * @param questionId - branded question identity returned by `send()`.
 * @returns fulfillment after the matching `send()` promise rejects `QUESTION_WITHDRAWN`, or immediately when none is pending.
 */
abstract withdraw(questionId: MemberQuestionId): Promise<void>

/**
 * Query the authoritative first terminal retained for reconnect replay.
 * @param questionId - branded question identity returned by `send()`.
 * @returns the retained terminal, or undefined while pending or unknown.
 */
abstract queryTerminal(questionId: MemberQuestionId): Promise<CompanionMemberQuestionSettledResult | undefined>
```

Types: [CompanionMemberQuestionSettledResult](remote-protocol.md)

Source: [`packages/interaction/member-question-sender/src/index.ts`](../../packages/interaction/member-question-sender/src/index.ts)

<a id="ctxmemberquestionworkspacebinding--memberquestionworkspacebinding"></a>

### `ctx.memberQuestionWorkspaceBinding` — `MemberQuestionWorkspaceBinding`

Local project-member Workspace association supplied by the Host composition.

```ts cordis-catalog
/**
 * Persist or replace the exact local Workspace selected during invitation acceptance.
 * @param accountId - authenticated receiving Account.
 * @param projectId - Cloud Project being joined.
 * @param workspaceId - exact local Workspace selected or cloned.
 */
bind(accountId: PlatformAccountId, projectId: ProjectId, workspaceId: Branded<'WorkspaceId'>): Promise<void>

/**
 * Read the persisted local Workspace selection without requiring one to exist.
 * @param accountId - authenticated receiving Account.
 * @param projectId - cloud Project whose local association is being inspected.
 * @returns exact local Workspace identity, or undefined before the first binding.
 */
lookup(accountId: PlatformAccountId, projectId: ProjectId): Promise<Branded<'WorkspaceId'> | undefined>

/**
 * Replace a binding only when its current value still matches the caller's observation.
 * @param accountId - authenticated receiving Account.
 * @param projectId - cloud Project whose local association is being repaired.
 * @param expectedWorkspaceId - exact current value observed by the caller, including undefined.
 * @param workspaceId - exact live Workspace proposed as the replacement.
 * @returns whether the comparison matched and the replacement committed.
 */
bindIfCurrent( accountId: PlatformAccountId, projectId: ProjectId, expectedWorkspaceId: Branded<'WorkspaceId'> | undefined, workspaceId: Branded<'WorkspaceId'>, ): Promise<boolean>

/**
 * Resolve one authenticated receiver/project pair to an existing Workspace id.
 * @param accountId - authenticated receiving Account.
 * @param projectId - cloud Project carried by the received operation.
 * @returns exact local Workspace identity.
 */
resolve(accountId: PlatformAccountId, projectId: ProjectId): Promise<Branded<'WorkspaceId'>>
```

Types: [PlatformAccountId](platform-account.md) · [ProjectId](project-membership.md) · [WorkspaceId](workspace.md)

Source: [`packages/interaction/member-question-receiver/src/types.ts`](../../packages/interaction/member-question-receiver/src/types.ts)

<a id="ctxuserquestions--userquestionservice"></a>

### `ctx.userQuestions` — `UserQuestionService`

`ctx.userQuestions`: one active UI provider plus an `ask()` API.

```ts cordis-catalog
/**
 * Register the UI provider. Only one provider may be active in a context.
 *
 * @param provider UI-side implementation that collects answers.
 * @returns Disposer that unregisters this provider.
 */
registerProvider(provider: UserQuestionProvider): () => void

/**
 * Ask the active UI provider and wait for the user's answer.
 *
 * When a caller supplies an agent, human interaction is valid only for the
 * exact live runtime root. Runtime ownership, not durable session lineage,
 * decides this boundary: an owned child has no human answerer and would
 * block forever, while a lineage-bearing session resumed as a new runtime
 * root may ask normally.
 *
 * @param request Questions, owner agent, and abort signal.
 * @returns The answer chosen or typed by the human.
 * @throws {UserQuestionError} code `CALLER_NOT_LIVE` when a supplied
 *   agent is not the registry's exact live instance, or `DELEGATED_CALLER`
 *   when that live agent is owned by another agent.
 */
async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
```

Source: [`packages/interaction/user-questions/src/index.ts`](../../packages/interaction/user-questions/src/index.ts)

<a id="member-question-receiver-events"></a>

### `member-question-receiver/*` events

<a id="member-question-receiverchanged--emit"></a>

#### `member-question-receiver/changed` — emit

The receiver ledger committed one authoritative question-state change.

```ts cordis-catalog
/**
 * The receiver ledger committed one authoritative question-state change.
 * @param change - durable revision, question identity, and committed state.
 * @mode emit
 */
'member-question-receiver/changed'(change: MemberQuestionReceiverChange): void
```

Source: [`packages/interaction/member-question-receiver/src/types.ts`](../../packages/interaction/member-question-receiver/src/types.ts)
<!-- END GENERATED cordis-surface -->
