/** Fail-closed Mobile Companion mutation authority. */

/** Process visibility and synchronization required before any Companion mutation. */
export interface CompanionConnectionState {
  foreground: boolean
  socketOpen: boolean
  synchronized: boolean
}

/** Mutation names used in fail-closed diagnostics. */
export type CompanionMutationName =
  | 'session-create'
  | 'prompt'
  | 'cancel'
  | 'approval'
  | 'question'
  | 'attachment'
  | 'history'
  | 'other-mutation'

/** Dynamic authority owned by one physical Companion connection generation. */
export interface CompanionMutationPermit {
  /** @returns whether the physical connection generation still owns the active decoder. */
  isCurrent(): boolean
  /** Reject unless this generation still owns synchronized foreground mutation authority. */
  requireCurrent(): void
}

/**
 * Whether the process may submit a Companion mutation.
 * @param state - current process state.
 * @returns true only after foreground reconnect and validated Desktop-authoritative sync.
 */
export function companionMayMutate(state: CompanionConnectionState | undefined): boolean {
  return state !== undefined && state.foreground && state.socketOpen && state.synchronized
}

/**
 * Reject a Mobile mutation until the foreground connection has consumed a validated Desktop resync.
 * @param state - process visibility and synchronization state.
 * @param mutation - mutation named in the diagnostic.
 */
export function requireCompanionMutation(
  state: CompanionConnectionState | undefined,
  mutation: CompanionMutationName,
): void {
  if (!companionMayMutate(state)) {
    throw new Error(`Companion ${mutation} requires foreground synchronization`)
  }
}
