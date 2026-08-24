/** Pairing-scoped ownership for Desktop-authoritative Companion live projection. */

import type { PersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import type { CompanionSessionId } from '@deepseek-ai/dsh-remote-protocol'

/** One coalescible Host change projected differently for open and hidden Sessions. */
export type DesktopCompanionLiveProjectionChange =
  | {
    readonly type: 'session'
    readonly sessionId: CompanionSessionId
    readonly includeConversation: boolean
    readonly observationEpoch: number
  }
  | { readonly type: 'surface' }

interface LiveProjectionConnection {
  readonly changed: (change: DesktopCompanionLiveProjectionChange) => void
  readonly disconnect: (error: Error) => void
}

/** Authenticated connection registry that retains at most one opened Session per Personal Pairing. */
export class DesktopCompanionLiveProjectionSource {
  private readonly connections = new Map<PersonalPairingId, Set<LiveProjectionConnection>>()
  private readonly observed = new Map<PersonalPairingId, CompanionSessionId>()
  private readonly observationEpochs = new Map<PersonalPairingId, number>()

  /**
   * Register one authenticated Snow connection.
   * @param pairingId - Personal Pairing authenticated by the connection.
   * @param changed - synchronous bounded-queue admission callback.
   * @param disconnect - callback that forces transport resynchronization after Host authority loss.
   * @returns disposer that clears the opened Session after the pairing's last connection leaves.
   */
  connect(
    pairingId: PersonalPairingId,
    changed: LiveProjectionConnection['changed'],
    disconnect: LiveProjectionConnection['disconnect'],
  ): () => void {
    const connection = { changed, disconnect }
    let entries = this.connections.get(pairingId)
    if (entries === undefined) this.connections.set(pairingId, entries = new Set())
    entries.add(connection)
    return () => {
      const current = this.connections.get(pairingId)
      if (current === undefined || !current.delete(connection)) return
      if (current.size > 0) return
      this.connections.delete(pairingId)
      this.observed.delete(pairingId)
      this.observationEpochs.delete(pairingId)
    }
  }

  /** Whether at least one authenticated connection still leases Host event streams. */
  hasConnections(): boolean { return this.connections.size > 0 }

  /** Select or clear the one Session receiving full live conversation replacements. */
  observe(pairingId: PersonalPairingId, sessionId?: CompanionSessionId): void {
    const previous = this.observed.get(pairingId)
    this.observationEpochs.set(pairingId, (this.observationEpochs.get(pairingId) ?? 0) + 1)
    if (sessionId === undefined) this.observed.delete(pairingId)
    else this.observed.set(pairingId, sessionId)
    if (previous !== undefined && previous !== sessionId) this.changed(previous)
    if (sessionId !== undefined) this.changed(sessionId)
  }

  /** Return the opened Session for connection and lifecycle tests. */
  observedSession(pairingId: PersonalPairingId): CompanionSessionId | undefined {
    return this.observed.get(pairingId)
  }

  /** Publish one committed Host Session change without awaiting network delivery. */
  changed(sessionId: CompanionSessionId): void {
    const errors: unknown[] = []
    for (const [pairingId, connections] of this.connections) {
      const change: DesktopCompanionLiveProjectionChange = {
        type: 'session', sessionId,
        includeConversation: this.observed.get(pairingId) === sessionId,
        observationEpoch: this.observationEpochs.get(pairingId) ?? 0,
      }
      for (const connection of [...connections]) {
        try { connection.changed(change) } catch (error) { errors.push(error) }
      }
    }
    if (errors.length > 0) {
      console.error('[desktop-companion] live projection subscriber failures:', new AggregateError(errors))
    }
  }

  /** Request a complete authoritative surface baseline after Workspace authority changes. */
  surfaceChanged(): void {
    const errors: unknown[] = []
    for (const connections of this.connections.values()) {
      for (const connection of [...connections]) {
        try { connection.changed({ type: 'surface' }) } catch (error) { errors.push(error) }
      }
    }
    if (errors.length > 0) {
      console.error('[desktop-companion] live projection subscriber failures:', new AggregateError(errors))
    }
  }

  /** Whether an in-flight detailed replacement still owns the open Session observation. */
  retainsConversation(pairingId: PersonalPairingId, change: DesktopCompanionLiveProjectionChange): boolean {
    return change.type === 'session' && change.includeConversation
      && this.observed.get(pairingId) === change.sessionId
      && this.observationEpochs.get(pairingId) === change.observationEpoch
  }

  /** Retire every connection before requesting transport reconnect after Host stream loss. */
  fail(error: Error): void {
    const connections = [...this.connections.values()].flatMap(entries => [...entries])
    this.connections.clear()
    this.observed.clear()
    this.observationEpochs.clear()
    const errors: unknown[] = []
    for (const connection of connections) {
      try { connection.disconnect(error) } catch (failure) { errors.push(failure) }
    }
    if (errors.length > 0) {
      console.error('[desktop-companion] live projection disconnect failures:', new AggregateError(errors))
    }
  }
}
