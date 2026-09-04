/** Client-safe question, answer, and event types. @module @deepseek-ai/dsh-user-questions/types */

import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import type {
  CompanionMemberQuestionOrigin,
  CompanionMemberQuestionReference,
  CompanionSessionId,
  ProjectId,
} from '@deepseek-ai/dsh-remote-protocol'

/** One selectable answer offered to the user. */
export interface AskUserQuestionOption {
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable UIs. */
  description?: string
}

/**
 * A caller-declared presentation intent: the question IS this kind of
 * decision, so a UI that recognises the tag may present it as such instead of as a
 * generic option list. Tagged so further intents can be added; a UI that does
 * not know a tag renders the generic flow, and the answer encoding is identical
 * either way — an intent changes presentation only, never the protocol.
 */
export type AskUserQuestionIntent =
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
     * `cachedPath` is the receiver-owned hidden Workspace copy the Files
     * viewer opens. A chip without it is a no-op and never opens `path`.
     * `content` is optional inline body for tests and older payloads; the
     * product Files viewer reads the cache path instead.
     */
    references: readonly { path: string; reason: string; cachedPath?: string; content?: string }[]
    /** Epoch milliseconds after which the routed ask expires on both endpoints. */
    expiresAt: number
  }

/** One question in a user-questions request. */
export interface AskUserQuestionItem {
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

/** Answer to one question. */
export interface AskUserQuestionAnswerItem {
  /** The answered question id. */
  id: string
  /** Selected option labels. May accompany custom text for a multi-select question. */
  selected: string[]
  /** Optional free-text "Other" answer. */
  custom?: string
}

/** The human's answer. */
export interface AskUserQuestionAnswer {
  /** Structured answers keyed by question id. */
  answers: AskUserQuestionAnswerItem[]
}

/** Minimal validated route for a Host member-question answerer. */
export interface AskUserQuestionMemberRoute {
  /** Cloud project containing the addressed member. */
  readonly projectId: ProjectId
  /** Durable Account id selected by the authenticated roster resolver. */
  readonly toProjectMember: PlatformAccountId
  /** Agent-authored Decision Brief background. */
  readonly background: string
  /** Workspace references using the Companion member-question vocabulary. */
  readonly references: readonly CompanionMemberQuestionReference[]
  /** Optional reference bytes aligned by index and path with `references`. */
  readonly documents?: readonly { readonly path: string; readonly bytes: Uint8Array }[]
  /** Authenticated public identity rendered with the Decision Brief. */
  readonly origin: Omit<CompanionMemberQuestionOrigin, 'askerAccountId'> & {
    readonly askerAccountId: PlatformAccountId
  }
  /** Protocol-native Session identity that owns the routed ask. */
  readonly originSessionId: CompanionSessionId
}

/** Client-safe payload declared for the user-question answerer waterfall. */
export interface AskUserQuestionRequestEvent {
  /** Questions to display. */
  questions: AskUserQuestionItem[]
  /** Agent identity projected to the corresponding Client Context in transit. */
  agent?: Agent
  /** Cancellation lifetime of the pending request. */
  signal?: AbortSignal
  /** Optional Host-only member route claimed by a composed unscoped answerer. */
  memberRoute?: AskUserQuestionMemberRoute
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask composed answerers for structured user input. Return an answer to
     * claim the request or call `next()` to delegate. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param request - pending user-question request.
     * @mode waterfall
     */
    'user-questions/request'(
      this: Scoped<Agent>,
      request: AskUserQuestionRequestEvent,
      next: () => Promise<AskUserQuestionAnswer>,
    ): Promise<AskUserQuestionAnswer>
  }
}
