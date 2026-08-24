/** Mobile settlement of Desktop-authorized approvals and Ask User questions. */

import { companionMayMutate, type CompanionConnectionState } from './companion-lifecycle.ts'

/** One Desktop-authorized interaction presented on Mobile. */
export interface CompanionInteraction {
  /** Idempotency key. */
  operationId: string
  /** Approval or Ask User. */
  kind: 'approval' | 'ask-user'
  /** Current arguments or question text. */
  summary: string
  /** Optional cwd shown for approvals. */
  cwd?: string
  /** Optional diff summary. */
  diff?: string
  /** Optional terminal summary. */
  terminal?: string
  /** Decisions Desktop already authorized, including persistent ones. */
  authorized: readonly string[]
  /** Desktop-authoritative settlement, if any. */
  settled?: { decision: string; persistent?: boolean }
}

/**
 * Apply a Mobile decision only after foreground reconnect, Desktop-authoritative
 * sync, and Desktop acceptance, and only if unset. Notification chrome cannot
 * satisfy the gate.
 * @param interaction - current interaction.
 * @param input - Mobile decision.
 * @param state - process visibility and synchronization required to mutate.
 * @returns the Desktop-authoritative interaction.
 */
export function settleCompanionInteraction(
  interaction: CompanionInteraction,
  input: { accepted: boolean; decision: string; persistent?: boolean; stale?: boolean },
  state: CompanionConnectionState,
): CompanionInteraction {
  if (!companionMayMutate(state)) return interaction
  if (interaction.settled !== undefined) return interaction
  if (!input.accepted || input.stale === true) return interaction
  return {
    ...interaction,
    settled: { decision: input.decision, ...(input.persistent === true ? { persistent: true } : {}) },
  }
}
