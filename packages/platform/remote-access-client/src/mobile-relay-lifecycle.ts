import type { RelayCredentialGrant } from '@deepseek-ai/dsh-remote-access'
import type { RelayAttachmentId } from '@deepseek-ai/dsh-remote-protocol'
import { RemoteRelayEndpointController, type RemoteRelayEndpointOptions } from './relay.ts'

/** Mobile-owned Relay lifecycle configured only by authority opened from a confirmed pairing. */
export class MobileRelayEndpointLifecycle {
  private grant: RelayCredentialGrant | undefined
  private readonly endpoint: RemoteRelayEndpointController

  /** @param options - Mobile endpoint adapters other than pairing-delivered route authority. */
  constructor(options: Omit<RemoteRelayEndpointOptions, 'endpoint' | 'route'>) {
    this.endpoint = new RemoteRelayEndpointController({
      ...options,
      endpoint: 'mobile',
      route: () => {
        if (this.grant === undefined) throw new Error('Mobile Relay authority is unavailable')
        return Promise.resolve(this.grant)
      },
    })
  }

  /**
   * Set or drop pairing-delivered Mobile authority.
   * @param grant - Mobile-specific authority, or `undefined` to drop it.
   */
  configure(grant?: RelayCredentialGrant): void { this.grant = grant }
  /** Attach after pairing confirmation. */
  async start(): Promise<void> { await this.endpoint.start() }
  /** Stop and drain the current Mobile attachment. */
  async stop(): Promise<void> { await this.endpoint.stop() }
  /** Report whether Platform acknowledged the current attachment.
   * @returns whether Platform acknowledged the current attachment.
   */
  isConnected(): boolean { return this.endpoint.isConnected() }

  /**
   * Send only on the current live Mobile attachment; offline sends are never retained.
   * @param targetAttachmentId - current Desktop attachment receiving the ciphertext.
   * @param ciphertext - bounded encrypted Companion Protocol frame.
   */
  async sendCiphertext(targetAttachmentId: RelayAttachmentId, ciphertext: Uint8Array): Promise<void> {
    await this.endpoint.sendCiphertext(targetAttachmentId, ciphertext)
  }
}
