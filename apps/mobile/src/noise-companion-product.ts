/** Shipped Mobile mutation adapter for one current Snow IK attachment. */

import type { PlatformAccountInstallation } from '@deepseek-ai/dsh-platform-account-client'
import { parsePersonalPairingId } from '@deepseek-ai/dsh-remote-access'
import {
  parseCompanionOperationId,
  parseCompanionSessionId,
  type CompanionOperation,
  type RelayAttachmentId,
  type RelayPairingSelector,
} from '@deepseek-ai/dsh-remote-protocol'
import type { SnowCompanionProtocolChannel } from '@deepseek-ai/dsh-noise-channel'
import { transferSelectedCompanionAttachment } from './companion-attachment.ts'
import type { CompanionForegroundRuntime } from './companion-lifecycle.ts'
import type { CompanionInteraction } from './companion-approval.ts'
import type { PairingCompanionKeyVault } from './companion-keys.ts'
import type { MobileCompanionMutationChannel } from './companion-surface.ts'

interface ActiveMobileSnowChannel {
  channel: SnowCompanionProtocolChannel
  targetAttachmentId: RelayAttachmentId
  pairingSelector: RelayPairingSelector
  generation: number
}

/** Mutable physical-connection owner shared by the Relay callbacks and the stable React adapter. */
export class MobileSnowCompanionConnection {
  private active: ActiveMobileSnowChannel | undefined

  /** Publish one completed current-generation IK channel. */
  connect(active: ActiveMobileSnowChannel): void {
    this.active = active
  }

  /** Invalidate the channel before its Snow transport is disposed. */
  disconnect(): void { this.active = undefined }

  /** @returns the exact current physical channel, or undefined while disconnected. */
  current(): ActiveMobileSnowChannel | undefined { return this.active }
}

/** Product dependencies that never leave endpoint-owned authority inside Platform. */
export interface MobileSnowCompanionProductOptions {
  runtime: CompanionForegroundRuntime
  connection: MobileSnowCompanionConnection
  installation: Pick<PlatformAccountInstallation, 'authorizeCurrentInstallation'>
  attachmentKeys: Pick<PairingCompanionKeyVault, 'attachmentKeyMaterial'>
  platformOrigin: string
  sendCiphertext(targetAttachmentId: RelayAttachmentId, ciphertext: Uint8Array): Promise<void>
  reportFailure?(error: unknown): void
}

/** Stable Mobile UI adapter whose every send revalidates current foreground generation. */
export class MobileSnowCompanionProductChannel implements MobileCompanionMutationChannel {
  /** @param options - current lifecycle, endpoint key vault, Account proof owner, and Relay sender. */
  constructor(private readonly options: MobileSnowCompanionProductOptions) {}

  create(): never { throw new Error('Companion Session creation is unavailable in this protocol version') }

  submit(sessionId: string, text: string): void {
    this.sendDetached({
      type: 'submit-prompt',
      operationId: operationId(),
      sessionId: parseCompanionSessionId(sessionId),
      text,
    })
  }

  cancel(): never { throw new Error('Companion cancellation is unavailable in this protocol version') }

  attach(sessionId: string, file: File): { operationId: ReturnType<typeof parseCompanionOperationId>; completion: Promise<void> } {
    const operationIdValue = operationId()
    const permit = this.options.runtime.bindCompanionMutationPermit('attachment')
    if (permit === undefined) throw new Error('Companion attachment has no current connection generation')
    const active = this.requireActive()
    const pairingId = parsePersonalPairingId(active.pairingSelector)
    const attachmentKey = this.options.attachmentKeys.attachmentKeyMaterial(pairingId)
    if (attachmentKey === undefined) throw new Error('Companion attachment has no retained attachment key')
    const completion = (async () => {
      try {
        const authorization = await this.options.installation.authorizeCurrentInstallation()
        permit.requireCurrent()
        await transferSelectedCompanionAttachment(file, {
          attachmentKey,
          origin: this.options.platformOrigin,
          authorizationHeaders: authorizationHeaders(authorization, active.pairingSelector),
          operationId: operationIdValue,
          sessionId: parseCompanionSessionId(sessionId),
          permit,
          send: async (offer) => { await this.sendCurrent(active, { type: 'operation', operation: offer }, permit) },
        })
      } finally {
        attachmentKey.fill(0)
      }
    })()
    return { operationId: operationIdValue, completion }
  }

  search(query: string): ReturnType<typeof parseCompanionOperationId> {
    const operationIdValue = operationId()
    this.sendDetached({ type: 'search-sessions', operationId: operationIdValue, query })
    return operationIdValue
  }

  settle(_interaction: CompanionInteraction): never {
    throw new Error('Companion interaction settlement is unavailable in this protocol version')
  }

  private sendDetached(operation: CompanionOperation): void {
    const permit = this.options.runtime.bindCompanionMutationPermit('other-mutation')
    if (permit === undefined) throw new Error('Companion operation has no current connection generation')
    const active = this.requireActive()
    void this.sendCurrent(active, { type: 'operation', operation }, permit).catch((error: unknown) => {
      this.options.reportFailure?.(error)
    })
  }

  private async sendCurrent(
    active: ActiveMobileSnowChannel,
    message: Parameters<SnowCompanionProtocolChannel['seal']>[0],
    permit: { requireCurrent(): void },
  ): Promise<void> {
    permit.requireCurrent()
    if (this.options.connection.current() !== active) throw new Error('Companion Snow channel was replaced')
    const ciphertext = active.channel.seal(message)
    permit.requireCurrent()
    await this.options.sendCiphertext(active.targetAttachmentId, ciphertext)
    permit.requireCurrent()
    if (this.options.connection.current() !== active) throw new Error('Companion Snow channel was replaced')
  }

  private requireActive(): ActiveMobileSnowChannel {
    const active = this.options.connection.current()
    if (active === undefined) throw new Error('Companion Snow channel is unavailable')
    return active
  }
}

function operationId(): ReturnType<typeof parseCompanionOperationId> {
  return parseCompanionOperationId(crypto.randomUUID())
}

function authorizationHeaders(
  authorization: Awaited<ReturnType<PlatformAccountInstallation['authorizeCurrentInstallation']>>,
  selector: RelayPairingSelector,
): Record<string, string> {
  return {
    Authorization: `Bearer ${authorization.accessToken}`,
    'X-Gestalt-Proof-Jti': authorization.proof.jti,
    'X-Gestalt-Proof-Issued-At': String(authorization.proof.issuedAt),
    'X-Gestalt-Proof-Signature': authorization.proof.signature,
    'X-Gestalt-Pairing-Selector': selector,
  }
}
