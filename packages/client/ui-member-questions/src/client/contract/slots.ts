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
import type { PendingInteraction, PendingWait } from '@deepseek-ai/dsh-client-runtime/client'

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

/** Code-point ceiling of the banner's background block, mirroring the sender's T4 bound. */
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
 * The receiver projection carried beside the question batch on the requested
 * frame: origin identity, referenced documents, and the expiry instant. The
 * relay milestone owns putting the fields on the wire; until it lands they are
 * absent and {@link memberBriefOf} yields the identity-lite brief, so this
 * structural read is the single narrowing site for the projection.
 */
interface MemberQuestionProjection {
  origin?: MemberQuestionOrigin
  references?: readonly { path: string; reason: string }[]
  expiresAt?: number
}

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
 * Background comes from the first question carrying supporting detail,
 * clamped to the banner budget; origin, references, and expiry ride the
 * receiver projection beside the batch and are absent until the relay
 * milestone puts them on the wire.
 *
 * @param wait - the claimed question carrier.
 * @returns The rendered brief.
 */
export function memberBriefOf(wait: MemberQuestionWait): MemberQuestionBrief {
  const projection = wait.payload as MemberQuestionProjection
  const background = clampBackground(
    wait.payload.questions.find(question => question.detail !== undefined)?.detail ?? '',
  )
  return {
    ...(projection.origin === undefined ? {} : { origin: projection.origin }),
    ...(background === '' ? {} : { background }),
    references: (projection.references ?? []).map(reference => ({
      filename: filenameOf(reference.path),
      reason: reference.reason,
    })),
    ...(projection.expiresAt === undefined ? {} : { expiresAt: projection.expiresAt }),
  }
}

/**
 * Chain routing: claim the composer while the pending request is a
 * member-question request (pure — owner props only). Registered ahead of the
 * generic question entry so `plan-review` requests and generic requests keep
 * electing the shared composer unchanged.
 */
export function selectMemberQuestion({ interactions }: { interactions: readonly PendingInteraction[] }):
    MemberQuestionWait | null {
  return interactions.find((wait): wait is MemberQuestionWait =>
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
