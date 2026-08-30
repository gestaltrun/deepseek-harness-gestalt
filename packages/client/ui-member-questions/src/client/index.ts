/**
 * Member-question plugin, browser half: the MemberQuestionCard registered as a
 * selector-routed entry of the conversation-declared composer chain, ahead of
 * the shared question composer, plus the `member-question` dictionaries. The
 * selector claims only requests whose whole batch declares the
 * `member-question` intent; `plan-review` and generic requests keep electing
 * the shared composer unchanged. The presentation and answer protocol stay
 * owned by dsh-client-ui-user-questions — this package mounts the sanctioned
 * presentation seam under its Decision Brief banner and binds the `question`
 * dictionary through the standard locale seat for it.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { MemberQuestionCard } from './MemberQuestionCard.tsx'
import { selectMemberQuestion } from './contract/slots.ts'
import { en, zh, type MemberQuestionKey } from './locales.ts'

export { selectMemberQuestion, isMemberQuestionBatch, memberBriefOf, clampBackground, BACKGROUND_CLAMP } from './contract/slots.ts'
export type {
  MemberQuestionBrief, MemberQuestionComposerProps, MemberQuestionOrigin,
  MemberQuestionReferenceChip, MemberQuestionRole, MemberQuestionWait,
} from './contract/slots.ts'
export type { MemberQuestionKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The member-question brief's copy. */
    'member-question': MemberQuestionKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'member-question'

/** Required services: the slot registry, this package's copy, and the shared question dictionary. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the `member-question` dictionaries and the
 * composite card into the composer chain at a priority ahead of the shared
 * question composer (default 0), so a member-question request elects this
 * wrapper and every other request falls through to the shared entries.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-member-questions: dictionaries')

  // The mounted presentation reads the `question` namespace (owned by
  // dsh-client-ui-user-questions); bind is stable per namespace, so the
  // injected translator never churns memo identity.
  const questionT = ctx.locale.bind('question')

  ctx.slots.inject('conversation.composer', () => ctx.slots.register(
    {
      name: 'conversation.composer',
      select: selectMemberQuestion,
      priority: -1,
      locale: NS,
      inject: () => ({ questionT }),
    },
    MemberQuestionCard,
  ))
}
