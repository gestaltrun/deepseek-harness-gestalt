/** Product-owned Mobile projection of authenticated Desktop Companion state. */

import type { CompanionInteraction } from './companion-approval.ts'
import type { CompanionSessionSummary } from './companion-history.ts'
import type { CompanionForegroundRuntime } from './companion-lifecycle.ts'
import { requireCompanionMutation, type CompanionMutationName } from './companion-mutation.ts'

interface ValidatedDesktopSurfaceResync {
  readonly type: 'desktop-resync'
  readonly version: 1
  readonly authenticated: true
  readonly desktopName: string
  readonly sessions: readonly CompanionSessionSummary[]
  readonly streaming: boolean
}

interface ValidatedDesktopSurfaceResyncReceiver {
  /** @param message - decoded projection authenticated for the receiver's physical connection. */
  acceptValidatedDesktopResync(message: ValidatedDesktopSurfaceResync): void
}

/** Current Desktop-confirmed content retained while a replacement connection resynchronizes. */
interface MobileCompanionSurfaceSnapshot {
  /** Desktop-owned name accepted only from the authenticated projection. */
  readonly desktopName?: string
  /** Last authenticated Session projection. */
  readonly sessions: readonly CompanionSessionSummary[]
  /** Last authenticated execution state. */
  readonly streaming: boolean
}

/** Optional encrypted mutation channel installed with the authenticated Companion decoder. */
interface MobileCompanionMutationChannel {
  /** @param input - Desktop-default Session target. */
  create(input: { workspace?: string }): void
  /** @param sessionId - Desktop Session target. @param text - prompt text. */
  submit(sessionId: string, text: string): void
  /** @param sessionId - Desktop Session target. */
  cancel(sessionId: string): void
  /** @param sessionId - Desktop Session target. */
  attach(sessionId: string): void
  /** @param interaction - Desktop-authorized approval or question settlement. */
  settle(interaction: CompanionInteraction): void
}

/** Generation-bound Desktop projection plus fail-closed Mobile mutation callbacks. */
export class MobileCompanionSurface {
  readonly #runtime: CompanionForegroundRuntime
  readonly #mutations: MobileCompanionMutationChannel | undefined
  readonly #listeners = new Set<() => void>()
  #snapshot: MobileCompanionSurfaceSnapshot = { sessions: [], streaming: false }

  /**
   * @param runtime - current physical-connection synchronization authority.
   * @param mutations - encrypted mutation channel; omitted until its decoder owns this surface.
   */
  constructor(runtime: CompanionForegroundRuntime, mutations?: MobileCompanionMutationChannel) {
    this.#runtime = runtime
    this.#mutations = mutations
  }

  /** @returns the last authenticated Desktop projection. */
  getSnapshot(): MobileCompanionSurfaceSnapshot {
    return this.#snapshot
  }

  /**
   * Subscribe to authenticated Desktop projection changes.
   * @param listener - observer invoked after an accepted projection.
   * @returns disposer.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /**
   * Bind projection acceptance to the current physical connection generation.
   * Raw Relay ciphertext cannot call this receiver.
   * @returns receiver for an authenticated decoder, or `undefined` while disconnected.
   */
  bindValidatedDesktopResync(): ValidatedDesktopSurfaceResyncReceiver | undefined {
    const lifecycleReceiver = this.#runtime.bindValidatedDesktopResync()
    if (lifecycleReceiver === undefined) return undefined
    return {
      acceptValidatedDesktopResync: (message) => {
        const accepted = lifecycleReceiver.acceptValidatedDesktopResync(message)
        if (!accepted) return
        this.#snapshot = {
          desktopName: message.desktopName,
          sessions: message.sessions.map(session => ({
            ...session,
            ...(session.transcript === undefined ? {} : { transcript: [...session.transcript] }),
            ...(session.blocks === undefined ? {} : { blocks: [...session.blocks] }),
          })),
          streaming: message.streaming,
        }
        this.publish()
      },
    }
  }

  /** @param input - Desktop-default Session target. */
  readonly create = (input: { workspace?: string }): void => {
    this.transmit('session-create', (channel) => { channel.create(input) })
  }

  /** @param sessionId - Desktop Session target. @param text - prompt text. */
  readonly submit = (sessionId: string, text: string): void => {
    this.transmit('prompt', (channel) => { channel.submit(sessionId, text) })
  }

  /** @param sessionId - Desktop Session target. */
  readonly cancel = (sessionId: string): void => {
    this.transmit('cancel', (channel) => { channel.cancel(sessionId) })
  }

  /** @param sessionId - Desktop Session target. */
  readonly attach = (sessionId: string): void => {
    this.transmit('attachment', (channel) => { channel.attach(sessionId) })
  }

  /** @param interaction - Desktop-authorized approval or question settlement. */
  readonly settle = (interaction: CompanionInteraction): void => {
    this.transmit(interaction.kind === 'approval' ? 'approval' : 'question', (channel) => { channel.settle(interaction) })
  }

  private transmit(kind: CompanionMutationName, send: (channel: MobileCompanionMutationChannel) => void): void {
    requireCompanionMutation(this.#runtime.getState(), kind)
    if (this.#mutations === undefined) {
      throw new Error('Companion encrypted mutation channel is unavailable')
    }
    send(this.#mutations)
  }

  private publish(): void {
    const errors: unknown[] = []
    for (const listener of [...this.#listeners]) {
      try { listener() } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) {
      console.error('[companion-surface] subscriber failures:', new AggregateError(errors))
    }
  }
}
