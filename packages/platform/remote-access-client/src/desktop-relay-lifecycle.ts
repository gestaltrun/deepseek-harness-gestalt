import type { RelayAttachmentId, RelayPairingSelector, RelayPeerUpdateMessage, RelayReadyMessage } from '@deepseek-ai/dsh-remote-protocol'
import type { RelayCredentialGrant } from '@deepseek-ai/dsh-remote-access'
import {
  RemoteRelayEndpointController,
  type DesktopRelayStopReason,
  type RemoteRelayEndpointOptions,
} from './relay.ts'

/** Desktop-owned Relay lifecycle injected by the product composition. */
export interface DesktopRelayLifecycle {
  /** Install fresh endpoint-owned authority returned by a successful Settings enable. */
  configure?(grant: RelayCredentialGrant): void | Promise<void>
  /** Reconcile the complete durable grant set, retiring selectors absent from it. */
  synchronize?(grants: readonly RelayCredentialGrant[]): Promise<void>
  /** Attach and resynchronize through the selected Platform endpoint. */
  start(): Promise<void>
  /** Make the route Remote Offline for one Desktop lifecycle reason. */
  stop(reason?: DesktopRelayStopReason): Promise<void>
  /** Read transport-only lifecycle state without exposing route authority. */
  getState?(): { connected: boolean; stopReason?: DesktopRelayStopReason }
}

type DesktopRelayEndpointLifecycleOptions = Omit<RemoteRelayEndpointOptions,
'endpoint' | 'route' | 'onCiphertext' | 'onPeerAttachments'> & {
  onPeerAttachments?: (
    message: RelayReadyMessage | RelayPeerUpdateMessage,
    pairingSelector: RelayPairingSelector,
  ) => void | Promise<void>
  onCiphertext?: (
    ciphertext: Uint8Array,
    sourceAttachmentId: RelayAttachmentId,
    localAttachmentId: RelayAttachmentId,
    pairingSelector: RelayPairingSelector,
  ) => void | Promise<void>
}

/** Observable fail-closed Relay lifecycle used before production crypto/provider approval. */
export class FailClosedDesktopRelayLifecycle implements DesktopRelayLifecycle {
  private stopReason: DesktopRelayStopReason | undefined

  /** @param reason - production gate diagnostic. */
  constructor(private readonly reason: string) {}

  configure(): Promise<void> { return Promise.reject(new Error(this.reason)) }
  start(): Promise<void> { return Promise.reject(new Error(this.reason)) }
  stop(reason: DesktopRelayStopReason = 'quit'): Promise<void> {
    this.stopReason = reason
    return Promise.resolve()
  }

  /** @returns observable offline state for entry/process acceptance checks. */
  getState(): { connected: false; stopReason?: DesktopRelayStopReason } {
    return { connected: false, ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }) }
  }
}

/** Real Desktop endpoint composition that owns its current route grant. */
export class DesktopRelayEndpointLifecycle implements DesktopRelayLifecycle {
  private readonly endpoints = new Map<RelayPairingSelector, DesktopRelayEndpointRecord>()
  private stopReason: DesktopRelayStopReason | undefined
  private serial: Promise<unknown> = Promise.resolve()
  private running = false
  private readonly options: DesktopRelayEndpointLifecycleOptions

  /** @param options - Desktop endpoint adapters other than route authority. */
  constructor(options: DesktopRelayEndpointLifecycleOptions) {
    this.options = options
  }

  configure(grant: RelayCredentialGrant): Promise<void> {
    const ownedGrant = cloneDesktopGrant(grant)
    return this.exclusive(async () => { await this.applyGrant(ownedGrant) })
  }

  /** @param grants - complete endpoint-owned grants currently retained by the Desktop vault. */
  synchronize(grants: readonly RelayCredentialGrant[]): Promise<void> {
    const ownedGrants = grants.map(cloneDesktopGrant)
    const selectors = new Set(ownedGrants.map(grant => grant.pairingSelector))
    if (selectors.size !== ownedGrants.length) throw new TypeError('Desktop Relay grant selectors must be unique')
    return this.exclusive(async () => {
      for (const [selector, record] of this.endpoints) {
        if (selectors.has(selector)) continue
        await this.retire(selector, record, 'mobile-access-disabled')
      }
      for (const grant of ownedGrants) await this.applyGrant(grant)
    })
  }

  private async applyGrant(grant: DesktopRelayGrant): Promise<void> {
    const selector = grant.pairingSelector
    const previous = this.endpoints.get(selector)
    if (previous !== undefined && sameGrant(previous.grant, grant)) return
    if (previous !== undefined) await this.retire(selector, previous, 'mobile-access-disabled')
    let localAttachmentId: RelayAttachmentId | undefined
    const token = { retired: false }
    const controller = new RemoteRelayEndpointController({
      ...this.options,
      endpoint: 'desktop',
      route: () => Promise.resolve(grant),
      onPeerAttachments: async (message: RelayReadyMessage | RelayPeerUpdateMessage) => {
        /* v8 ignore next -- the controller drops stopped-socket frames; this guard owns a callback already queued at retirement. */
        if (token.retired || this.endpoints.get(selector)?.token !== token) return
        localAttachmentId = message.attachmentId
        await this.options.onPeerAttachments?.(message, selector)
      },
      onCiphertext: async (ciphertext, sourceAttachmentId) => {
        /* v8 ignore next -- the controller drops stopped-socket frames; this guard owns a callback already queued at retirement. */
        if (token.retired || this.endpoints.get(selector)?.token !== token) return
        /* v8 ignore next -- ready assigns the attachment id before the controller can dispatch ciphertext. */
        if (localAttachmentId === undefined) throw new Error('Desktop Relay has no local attachment identity')
        await this.options.onCiphertext?.(ciphertext, sourceAttachmentId, localAttachmentId, selector)
      },
    })
    const record = { controller, grant, token }
    this.endpoints.set(selector, record)
    if (this.running) await controller.start()
  }

  async start(): Promise<void> {
    await this.exclusive(async () => {
      this.running = true
      await Promise.all([...this.endpoints.values()].map(async ({ controller }) => { await controller.start() }))
      this.stopReason = undefined
    })
  }
  async stop(reason: DesktopRelayStopReason = 'quit'): Promise<void> {
    this.running = false
    const preempted = Promise.allSettled(
      [...this.endpoints.values()].map(async ({ controller }) => { await controller.stop(reason) }),
    )
    await this.exclusive(async () => {
      try {
        const settled = [
          ...await preempted,
          ...await Promise.allSettled(
            [...this.endpoints.values()].map(async ({ controller }) => { await controller.stop(reason) }),
          ),
        ]
        const failures: unknown[] = []
        for (const result of settled) {
          if (result.status === 'rejected' && !failures.includes(result.reason as unknown)) {
            failures.push(result.reason as unknown)
          }
        }
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'Desktop Relay stop failed')
      } finally { this.stopReason = reason }
    })
  }

  /** @returns observed attachment ownership and the last completed stop reason. */
  getState(): { connected: boolean; stopReason?: DesktopRelayStopReason } {
    return {
      connected: [...this.endpoints.values()].some(({ controller }) => controller.isConnected()),
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
    }
  }

  /**
   * Send encrypted Companion Protocol bytes through the owned live attachment.
   * @param pairingSelector - pairing-scoped Desktop authority choosing the physical controller.
   * @param targetAttachmentId - live Mobile attachment.
   * @param ciphertext - bounded encrypted frame.
   */
  async sendCiphertext(
    pairingSelector: RelayPairingSelector,
    targetAttachmentId: RelayAttachmentId,
    ciphertext: Uint8Array,
  ): Promise<void> {
    await this.exclusive(async () => {
      const record = this.endpoints.get(pairingSelector)
      /* v8 ignore next -- retirement deletes the record before setting any replacement; retained records are never retired. */
      if (record === undefined || record.token.retired) throw new Error('Desktop Relay pairing authority is unavailable')
      await record.controller.sendCiphertext(targetAttachmentId, ciphertext)
    })
  }
  private async retire(
    selector: RelayPairingSelector,
    record: DesktopRelayEndpointRecord,
    reason: DesktopRelayStopReason,
  ): Promise<void> {
    record.token.retired = true
    /* v8 ignore else -- only the owning serialized operation can replace this map entry. */
    if (this.endpoints.get(selector) === record) this.endpoints.delete(selector)
    await record.controller.stop(reason)
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation)
    this.serial = result.then(() => undefined, () => undefined)
    return result
  }
}

type DesktopRelayGrant = RelayCredentialGrant & {
  endpoint: 'desktop'
  pairingSelector: RelayPairingSelector
}

interface DesktopRelayEndpointRecord {
  controller: RemoteRelayEndpointController
  grant: DesktopRelayGrant
  token: { retired: boolean }
}

function cloneDesktopGrant(grant: RelayCredentialGrant): DesktopRelayGrant {
  if (grant.endpoint !== 'desktop' || grant.pairingSelector === undefined) {
    throw new TypeError('Desktop Relay grant must belong to one Personal Pairing')
  }
  return { ...grant, endpoint: 'desktop', pairingSelector: grant.pairingSelector }
}

function sameGrant(left: DesktopRelayGrant, right: DesktopRelayGrant): boolean {
  return left.routeId === right.routeId
    && left.credential === right.credential
    && left.revision === right.revision
    && left.pairingSelector === right.pairingSelector
}
