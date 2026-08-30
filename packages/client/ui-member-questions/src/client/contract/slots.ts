/**
 * Member-question slot contract: the registrant-side props composition for
 * the conversation-owned `conversation.composer` chain, plus the receiver-side
 * Decision Brief face over the shared question carrier. The carrier
 * (PendingWait) and the question protocol stay owned by
 * dsh-client-ui-user-questions; this package adds only the banner faces a
 * receiver renders around the shared presentation.
 */
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Pulls ui-conversation's SlotMap merge (the 'conversation.composer' entry)
// and the locale plugin's Context merge into every program that sees this
// contract, so PropsRuntime and TranslateNS resolve.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// The shared question presentation's namespace merge ('question') and the
// sanctioned presentation seam this wrapper mounts under the banner.
import type {} from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { PendingInteraction, PendingWait, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { DetailsDocumentFocus } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** The pending question carrier a member brief renders and settles. */
export type MemberQuestionWait = PendingWait<'question'>

/** Collaboration-plane role of the asking member, as the receiver renders it. */
export type MemberQuestionRole = 'owner' | 'admin' | 'member'

/**
 * Remote origin of one member-directed question, bounded to the public
 * identity fields the receiver's brief banner renders. Mirrors the Companion
 * `CompanionMemberQuestionOrigin` face.
 */
export interface MemberQuestionOrigin {
  /** Display name of the cloud project the asking workspace is bound to. */
  projectName: string
  /** One-line title of the originating session; never carries conversation content. */
  originSessionTitle: string
  /** Public display name shown beside the asker avatar. */
  askerDisplayName: string
  /** Avatar image URL rendered beside the display name; absent renders the initial. */
  askerAvatarUrl?: string
  askerRole: MemberQuestionRole
}

/** One referenced document rendered as a material chip. */
export interface MemberQuestionReferenceChip {
  /** File name rendered as the chip title (the path's last segment). */
  filename: string
  /** Why this document matters, rendered as the chip subtitle. */
  reason: string
  /** Workspace-relative document path, forwarded on document focus. */
  path: string
  /** Inline document body for the renderable kinds; absent renders the bare file tab. */
  content?: string
}

/**
 * The receiver-side Decision Brief of one member-question request: everything
 * the banner renders besides the shared question presentation itself.
 */
export interface MemberQuestionBrief {
  /** Remote origin identity; absent renders the identity-lite banner. */
  origin?: MemberQuestionOrigin
  /** Agent-authored decision background, clamped to {@link BACKGROUND_CLAMP} code points. */
  background?: string
  /** Referenced documents, chip order preserved from the request. */
  references: readonly MemberQuestionReferenceChip[]
  /** Epoch milliseconds after which the routed ask expires; absent renders no countdown. */
  expiresAt?: number
}

/** Code-point ceiling of the banner's background block, matching routed-ask construction. */
export const BACKGROUND_CLAMP = 600

/**
 * Clamp the background to the banner's code-point budget without cutting a
 * surrogate pair in half.
 * @param text - the unbounded background text.
 * @returns At most the first 600 code points.
 */
export function clampBackground(text: string): string {
  const points = Array.from(text)
  return points.length <= BACKGROUND_CLAMP ? text : points.slice(0, BACKGROUND_CLAMP).join('')
}

/**
 * The member-question intent carries the receiver projection on the wire
 * (origin identity, background, references, expiry), so this read narrows the
 * carried brief off the batch's shared intent.
 */
type MemberQuestionCarriedIntent = Extract<
  NonNullable<MemberQuestionWait['payload']['questions'][number]['intent']>,
  { kind: 'member-question' }
>

/** File name of a referenced document path. */
function filenameOf(path: string): string {
  const segments = path.split('/')
  return segments[segments.length - 1] ?? path
}

/**
 * Whether a request batch is a member-question request: every question of the
 * batch declares the `member-question` intent. The banner is one request-level
 * Decision Brief, so a batch mixing intents (or carrying any generic or
 * plan-review question) stays with the generic composer entry — an intent
 * changes presentation, never which requests each surface can answer.
 *
 * @param questions - the request's whole question batch.
 * @returns Whether the member-question wrapper claims the request.
 */
export function isMemberQuestionBatch(
  questions: readonly { intent?: { kind: string } & object }[],
): boolean {
  return questions.length > 0
    && questions.every(question => question.intent?.kind === 'member-question')
}

/**
 * Build the banner's Decision Brief over a claimed member-question request.
 * Origin, background, references, and expiry come from the batch's shared
 * carried intent; when a request predates the carried fields (or a test
 * fixture omits them), background falls back to the first supporting detail
 * and the brief renders identity-lite.
 *
 * @param wait - the claimed question carrier.
 * @returns The rendered brief.
 */
export function memberBriefOf(wait: MemberQuestionWait): MemberQuestionBrief {
  const intent = wait.payload.questions.find(question => question.intent?.kind === 'member-question')
    ?.intent
  // A brief counts as carried only with its origin identity present: a bare
  // `member-question` tag (pre-relay payloads, minimal fixtures) renders the
  // identity-lite face with the detail-derived background fallback.
  const carried = intent?.kind === 'member-question'
    && (intent as Partial<MemberQuestionCarriedIntent>).origin !== undefined
    ? intent
    : undefined
  const fallback = clampBackground(
    wait.payload.questions.find(question => question.detail !== undefined)?.detail ?? '',
  )
  const background = clampBackground(carried?.background ?? fallback)
  return {
    ...(carried === undefined ? {} : {
      origin: {
        projectName: carried.origin.projectName,
        originSessionTitle: carried.origin.originSessionTitle,
        askerDisplayName: carried.origin.askerDisplayName,
        askerAvatarUrl: carried.origin.askerAvatarUrl,
        askerRole: carried.origin.askerRole,
      },
    }),
    ...(background === '' ? {} : { background }),
    references: (carried?.references ?? []).map(reference => ({
      filename: filenameOf(reference.path),
      reason: reference.reason,
      path: reference.path,
      ...(reference.content === undefined ? {} : { content: reference.content }),
    })),
    ...(carried === undefined ? {} : { expiresAt: carried.expiresAt }),
  }
}

/**
 * Chain routing: claim the composer while the pending request is a
 * member-question request (pure — owner props only). Registered ahead of the
 * generic question entry so `plan-review` requests and generic requests keep
 * electing the shared composer unchanged.
 * @param owner - the composer chain's owner props, carrying `interactions`.
 * @returns the member-question wait when the batch declares the intent, else null.
 */
export function selectMemberQuestion(owner: { interactions: readonly PendingInteraction[] }): MemberQuestionWait | null {
  return owner.interactions.find((wait): wait is MemberQuestionWait =>
    wait.kind === 'question' && isMemberQuestionBatch(wait.payload.questions)) ?? null
}

/**
 * Full component props: the framework runtime share (chain currency +
 * session/global standard kit) plus the chain `matched` share — the selector
 * result, already narrowed to the member-question carrier — plus the standard
 * locale seat for this package's `member-question` dictionary, plus the
 * injected shared-question translator the apply closure binds for the mounted
 * question presentation.
 */
export type MemberQuestionComposerProps =
  PropsRuntime<'conversation.composer'>
  & { matched: MemberQuestionWait }
  & PropsLocale<'member-question'>
  & { questionT: TranslateNS<'question'> }
  & {
    /**
     * Focus a referenced document in the session's details panel. The callback
     * resolves `ctx.get('detailsFocus')` per gesture; absent providers make it
     * a no-op, and providers registered after this entry are available.
     */
    focusDocument: (sessionId: SessionId, document: DetailsDocumentFocus) => void
  }
