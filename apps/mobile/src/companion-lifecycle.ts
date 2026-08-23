/** Foreground Relay lifecycle and Desktop-authoritative synchronization. */

import { registerPlugin } from '@capacitor/core'
import type { RelayCredentialGrant } from '@deepseek-ai/dsh-remote-access'
import {
  requireCompanionMutation,
  type CompanionConnectionState,
  type CompanionMutationName,
  type CompanionMutationPermit,
} from './companion-mutation.ts'

export {
  companionMayMutate,
  type CompanionConnectionState,
} from './companion-mutation.ts'

/** Authenticated, decoded Desktop resynchronization message supplied by the Encrypted Companion decoder. */
interface ValidatedDesktopResync {
  readonly type: 'desktop-resync'
  readonly version: 1
  readonly authenticated: true
}

/** Generation-bound receiver called only by the authenticated Encrypted Companion decoder. */
interface ValidatedDesktopResyncReceiver {
  /** @param message - validated resync for the physical connection that created this receiver. */
  /** @returns whether this receiver still owns the active connection generation. */
  acceptValidatedDesktopResync(message: ValidatedDesktopResync): boolean
}

/** Relay lifecycle the foreground runtime actually starts and stops. */
export interface CompanionRelayLifecycle {
  configure?(grant?: RelayCredentialGrant): void
  start(): Promise<void>
  stop(): Promise<void>
  isConnected(): boolean
}

interface CapacitorAppPlugin {
  addListener(
    eventName: 'appStateChange',
    listenerFunc: (state: { isActive: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

let installed: CompanionForegroundRuntime | undefined

/**
 * Pause WSS in background. Foreground never fabricates a live socket.
 * @param state - current process state.
 * @param foreground - next visibility.
 * @returns updated process state; background never keeps a socket or mutation right.
 */
export function setCompanionForeground(
  state: CompanionConnectionState,
  foreground: boolean,
): CompanionConnectionState {
  if (!foreground) {
    return { ...state, foreground: false, socketOpen: false, synchronized: false }
  }
  return { ...state, foreground: true, socketOpen: false, synchronized: false }
}

/**
 * Record that the real Relay lifecycle acknowledged an attachment after foreground start.
 * @param state - current process state.
 * @returns state with a live socket only while already foregrounded.
 */
export function markCompanionSocketOpen(state: CompanionConnectionState): CompanionConnectionState {
  if (!state.foreground) return { ...state, socketOpen: false, synchronized: false }
  return { ...state, socketOpen: true, synchronized: false }
}

/**
 * Record that Desktop-authoritative synchronization finished after foreground reconnect.
 * @param state - current process state.
 * @returns state that may enable mutations when already foregrounded and attached.
 */
function markCompanionSynchronized(state: CompanionConnectionState): CompanionConnectionState {
  if (!state.foreground || !state.socketOpen) return { ...state, synchronized: false }
  return { ...state, synchronized: true }
}

/** Process-owned foreground, socket, and synchronization state. */
export class CompanionForegroundRuntime {
  private state: CompanionConnectionState
  private granted = false
  private transition: Promise<void> = Promise.resolve()
  private connectionGeneration = 0
  private activeConnectionGeneration: number | undefined
  private readonly relay: CompanionRelayLifecycle | undefined
  private readonly listeners = new Set<() => void>()

  /** @param options - optional real Relay lifecycle; unpaired compositions omit it. */
  constructor(options: { relay?: CompanionRelayLifecycle } = {}) {
    this.relay = options.relay
    this.state = { foreground: true, socketOpen: false, synchronized: false }
  }

  /** @returns the current process visibility and synchronization snapshot. */
  getState(): CompanionConnectionState {
    return this.state
  }

  /**
   * Subscribe to process-state transitions.
   * @param listener - observer invoked after each published change.
   * @returns disposer.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Set or drop pairing-delivered Relay authority. Every authority change
   * synchronously invalidates the current connection generation; clearing the
   * grant also prevents a later visibility `start()` from attaching.
   * @param grant - Mobile-specific authority, or `undefined` to drop it.
   */
  configure(grant?: RelayCredentialGrant): void {
    this.granted = grant !== undefined
    this.relay?.configure?.(grant)
    this.activeConnectionGeneration = undefined
    this.state = { ...this.state, socketOpen: false, synchronized: false }
    this.publish()
  }

  /**
   * Attach after pairing confirmation. Shares the runtime transition queue
   * with visibility so a late `stop()` cannot tear down a newer `start()`.
   */
  async start(): Promise<void> {
    await this.enqueue(() => this.startOwned())
  }

  /** Stop and drain the current Mobile attachment through the shared queue. */
  async stop(): Promise<void> {
    await this.enqueue(() => this.stopOwned())
  }

  /**
   * Apply OS visibility. Background stops the real Relay socket; foreground
   * starts it only while a grant is present and records `socketOpen` only
   * after `isConnected()`.
   * @param foreground - next visibility.
   */
  async setForeground(foreground: boolean): Promise<void> {
    await this.enqueue(() => this.applyForeground(foreground))
  }

  /** Record one Platform-acknowledged physical connection and invalidate earlier resync receivers. */
  markConnectionOpen(): void {
    if (!this.granted || !this.state.foreground) return
    this.connectionGeneration += 1
    this.activeConnectionGeneration = this.connectionGeneration
    this.state = markCompanionSocketOpen(this.state)
    this.publish()
  }

  /**
   * Bind Desktop resynchronization to the current physical connection generation.
   * Raw Relay ciphertext must never receive or call this receiver.
   * @returns a generation-bound receiver, or `undefined` while disconnected.
   */
  bindValidatedDesktopResync(): ValidatedDesktopResyncReceiver | undefined {
    const generation = this.activeConnectionGeneration
    if (generation === undefined || !this.state.socketOpen) return undefined
    return {
      acceptValidatedDesktopResync: (message) => {
        if (!this.granted || this.activeConnectionGeneration !== generation) return false
        void message
        this.state = markCompanionSynchronized(this.state)
        this.publish()
        return this.state.synchronized
      },
    }
  }

  /**
   * Bind dynamic mutation authority to the current physical connection generation.
   * Long-running controllers must re-check it after every external await.
   * @param mutation - operation named in a foreground-synchronization refusal.
   * @returns generation permit, or `undefined` while no physical connection is active.
   */
  bindCompanionMutationPermit(mutation: CompanionMutationName): CompanionMutationPermit | undefined {
    const generation = this.activeConnectionGeneration
    if (generation === undefined || !this.state.socketOpen) return undefined
    const isCurrent = (): boolean => this.granted
      && this.activeConnectionGeneration === generation
      && this.state.foreground
      && this.state.socketOpen
    return {
      isCurrent,
      requireCurrent: () => {
        if (!isCurrent()) {
          throw new Error(`Companion ${mutation} connection generation is no longer current`)
        }
        requireCompanionMutation(this.state, mutation)
      },
    }
  }

  /** Drop pairing-delivered authority, reset connection state, and stop Relay. */
  async releasePairing(): Promise<void> {
    this.configure(undefined)
    await this.enqueue(() => this.stopOwned())
  }

  /** Reset socket and synchronization state after connection loss. */
  forgetConnection(): void {
    this.activeConnectionGeneration = undefined
    this.state = { ...this.state, socketOpen: false, synchronized: false }
    this.publish()
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.transition.then(operation, operation)
    this.transition = result.then(() => undefined, () => undefined)
    return result
  }

  private async applyForeground(foreground: boolean): Promise<void> {
    if (!foreground) this.activeConnectionGeneration = undefined
    this.state = setCompanionForeground(this.state, foreground)
    this.publish()
    if (!foreground) {
      await this.stopOwned()
      return
    }
    await this.startOwned()
  }

  private pairingIsLive(): boolean {
    return this.granted && this.state.foreground
  }

  private async startOwned(): Promise<void> {
    if (this.relay === undefined || !this.pairingIsLive()) return
    await this.relay.start()
    if (!this.pairingIsLive()) {
      await this.relay.stop()
      return
    }
    if (this.relay.isConnected()) {
      if (!this.state.socketOpen) this.markConnectionOpen()
    }
  }

  private async stopOwned(): Promise<void> {
    await this.relay?.stop()
  }

  private publish(): void {
    const errors: unknown[] = []
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) {
      console.error('[companion-foreground] subscriber failures:', new AggregateError(errors))
    }
  }
}

/**
 * Install the process-owned runtime used by the Mobile entry and settlement UI.
 * @param runtime - composition runtime.
 * @returns disposer that forgets only this runtime.
 */
export function installCompanionRuntime(runtime: CompanionForegroundRuntime): () => void {
  installed = runtime
  return () => { if (installed === runtime) installed = undefined }
}

/** @returns the runtime installed by the Mobile entry, if any. */
export function companionRuntime(): CompanionForegroundRuntime | undefined {
  return installed
}

/**
 * Bind document visibility and Capacitor app state to the real Relay lifecycle.
 * @param runtime - process-owned foreground runtime.
 * @param hooks - optional App-state listener factory; omitted in the product entry.
 * @returns disposer that waits for a pending Capacitor handle before `remove()`.
 */
export function bindCompanionProcessVisibility(
  runtime: CompanionForegroundRuntime,
  hooks: {
    listenAppState?: (listener: (active: boolean) => void) => Promise<{ remove: () => Promise<void> }>
  } = {},
): () => Promise<void> {
  const onVisibility = (): void => {
    void runtime.setForeground(document.visibilityState === 'visible')
  }
  const onPageHide = (): void => { void runtime.setForeground(false) }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  const pendingHandle = Promise.resolve()
    .then(() => (hooks.listenAppState ?? listenCapacitorAppState)((active) => {
      void runtime.setForeground(active)
    }))
    .then(handle => handle, () => undefined)
  return async () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    const handle = await pendingHandle
    if (handle !== undefined) await handle.remove()
  }
}

function listenCapacitorAppState(
  listener: (active: boolean) => void,
): Promise<{ remove: () => Promise<void> }> {
  const App = registerPlugin<CapacitorAppPlugin>('App')
  return App.addListener('appStateChange', (state) => { listener(state.isActive) })
}
