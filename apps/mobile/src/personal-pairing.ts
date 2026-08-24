/** Signed-in Mobile Personal Pairing controller over the public Remote Access transport. */

import {
  PAIRING_REPLAY_RETENTION_MS,
  RemoteAccessError,
  parsePairingInvitationLink,
  type PairingCompletionId,
  type PairingCompletionView,
  type PendingPairingId,
  type PersonalPairingId,
  type RelayCredentialGrant,
} from '@deepseek-ai/dsh-remote-access'
import type { PlatformAccountId } from '@deepseek-ai/dsh-platform-account'
import type { PlatformAccountInstallation } from '@deepseek-ai/dsh-platform-account-client'
import type { RemoteAccessTransport } from '@deepseek-ai/dsh-remote-access-client'
import type { MobilePairingActions, MobilePairingSnapshot } from './personal-pairing-model.ts'

/** Process-owned foreground Relay lifecycle released on unpair and Account change. */
interface MobilePairingLifecycleOwner {
  forgetConnection(): void
  releasePairing(): Promise<void>
}

/** Mobile handshake half selected by the reviewed product composition. */
export interface MobilePairingHandshakeClient {
  /** Prepare one Mobile handshake message and id for the complete invitation. */
  begin(oneTimeLink: string): Promise<{ completionId: PairingCompletionId; mobileHandshake: Uint8Array }>
  /** Consume the Desktop handshake response before exposing authentication words. */
  acceptDesktopHandshake(desktopHandshake: Uint8Array): Promise<void>
  /** Open Mobile-specific Relay authority sealed to this Personal Pairing. */
  openRelayAuthority?(sealedAuthority: Uint8Array): Promise<RelayCredentialGrant>
  /**
   * Export the independent pairing key retained after the Desktop handshake.
   * @returns copy of at least 32 bytes, or undefined before activation.
   */
  exportPairingKeyMaterial?(): Uint8Array | undefined
  /** Wipe any retained pairing key material on this installation. */
  wipe?(): void | Promise<void>
}

/** Retention sink for confirmed Personal Pairing key material. */
export interface MobilePairingKeyRetention {
  /**
   * Retain the independent key material of one confirmed Personal Pairing.
   * @param pairingId - confirmed Personal Pairing identity.
   * @param material - at least 32 bytes of pairing key material.
   */
  retain(pairingId: PersonalPairingId, material: Uint8Array): void
  /** Zero every retained pairing key. */
  wipe(): void
}

/** Native QR scanner returning the exact full invitation payload. */
interface MobilePairingQrScanner {
  /** @returns exact full invitation payload from the native scanner. */
  scan(): Promise<string>
}

interface PreparedMobilePairingAttempt {
  link: string
  expiresAt: number
  accountId: PlatformAccountId
  completionId: PairingCompletionId
  mobileHandshake: Uint8Array
  transmission: 'prepared' | 'possibly-committed' | 'pending'
  replayExpiresAt?: number
  pendingProjection?: PairingCompletionView
}

/** Mobile controller construction inputs. */
export interface MobilePairingControllerOptions {
  installation: Pick<PlatformAccountInstallation, 'authorizeCurrentInstallation' | 'getSnapshot'>
  transport: RemoteAccessTransport
  handshake: MobilePairingHandshakeClient
  scanner: MobilePairingQrScanner
  device: { name: string; platform: 'ios' | 'android' }
  /** Product Relay lifecycle receiving only Mobile-specific authority. */
  relay?: {
    configure(grant?: RelayCredentialGrant): void | Promise<void>
    start(): Promise<void>
    stop(): Promise<void>
  }
  /** Process-owned foreground Relay lifecycle. */
  companion?: MobilePairingLifecycleOwner
  /** Optional retention sink receiving confirmed pairing key material for pairing-scoped consumers. */
  pairingKeys?: MobilePairingKeyRetention
  schedule?: (task: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  pollIntervalMs?: number
  now?: () => number
}

/** Real signed-in Mobile controller; no short-code path exists. */
export class MobilePairingController implements MobilePairingActions {
  private snapshot: MobilePairingSnapshot = { status: 'ready' }
  private readonly listeners = new Set<() => void>()
  private serial: Promise<void> = Promise.resolve()
  private readonly schedule: (task: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly pollIntervalMs: number
  private readonly now: () => number
  private timer: ReturnType<typeof setTimeout> | undefined
  private attempt: PreparedMobilePairingAttempt | undefined
  private accountId: PlatformAccountId | undefined
  private active = true
  private lifecycleBarrier: Promise<void> = Promise.resolve()

  /** @param options - Account authority, Remote Access transport, reviewed handshake, and QR scanner. */
  constructor(private readonly options: MobilePairingControllerOptions) {
    this.schedule = options.schedule ?? ((task, delayMs) => setTimeout(task, delayMs))
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new TypeError('Mobile Pairing poll interval must be a positive integer')
    }
  }

  getSnapshot(): MobilePairingSnapshot { return this.snapshot }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async activate(): Promise<void> {
    await this.lifecycleBarrier
    await this.serial
    const accountId = this.currentAccountId()
    if (this.accountId !== accountId) this.resetAccountScope()
    this.accountId = accountId
    this.active = true
  }

  async unpair(): Promise<void> {
    await this.exclusive(async () => {
      this.assertActiveAccount()
      this.attempt?.mobileHandshake.fill(0)
      this.clearAttempt()
      await this.options.handshake.wipe?.()
      this.options.pairingKeys?.wipe()
      if (this.options.companion !== undefined) {
        await this.options.companion.releasePairing()
      }
      if (this.options.relay !== this.options.companion) {
        await this.options.relay?.configure(undefined)
        await this.options.relay?.stop()
      }
      this.publish({ status: 'ready' })
    })
  }

  async deactivate(): Promise<void> {
    this.active = false
    this.resetAccountScope()
    const transaction = (async () => {
      const first = await Promise.allSettled([this.options.relay?.stop() ?? Promise.resolve(), this.serial])
      const final = await Promise.allSettled([this.options.relay?.stop() ?? Promise.resolve()])
      this.resetAccountScope()
      throwRejected([...first, ...final], 'Mobile Personal Pairing deactivation failed')
    })()
    this.lifecycleBarrier = transaction.then(() => undefined, () => undefined)
    await transaction
  }

  async completeLink(link: string): Promise<void> {
    await this.exclusive(async () => { await this.completeLinkOwned(link) })
  }

  async scanQr(): Promise<void> {
    await this.exclusive(async () => {
      const payload = await this.options.scanner.scan()
      this.assertActiveAccount()
      await this.completeLinkOwned(payload)
    })
  }

  async retryPairing(): Promise<void> {
    await this.exclusive(async () => {
      const attempt = this.currentAttempt()
      if (attempt === undefined) throw new Error('No retryable Personal Pairing attempt is available')
      await this.runAttempt(attempt)
    })
  }

  private async prepareAttempt(link: string): Promise<PreparedMobilePairingAttempt> {
    const invitation = parsePairingInvitationLink(link)
    if (this.now() >= invitation.expiresAt) throw new Error('Personal Pairing invitation expired')
    const prepared = await this.options.handshake.begin(link)
    const attempt = {
      link,
      expiresAt: invitation.expiresAt,
      accountId: this.requireAccountId(),
      completionId: prepared.completionId,
      mobileHandshake: prepared.mobileHandshake,
      transmission: 'prepared' as const,
    }
    this.attempt = attempt
    return attempt
  }

  private async runAttempt(attempt: PreparedMobilePairingAttempt): Promise<void> {
    this.publish({ status: 'completing' })
    try {
      const authentication = await this.options.installation.authorizeCurrentInstallation()
      this.assertActiveAccount()
      attempt.transmission = 'possibly-committed'
      attempt.replayExpiresAt = this.now() + PAIRING_REPLAY_RETENTION_MS
      const completion = await this.options.transport.completeChallenge({
        authentication,
        completionId: attempt.completionId,
        oneTimeLink: attempt.link,
        device: this.options.device,
        mobileHandshake: attempt.mobileHandshake,
      })
      this.assertActiveAccount()
      attempt.pendingProjection = completion
      attempt.transmission = 'pending'
      await this.options.handshake.acceptDesktopHandshake(completion.desktopHandshake)
      this.assertActiveAccount()
      this.publish({
        status: 'pending',
        deviceName: this.options.device.name,
        authenticationWords: completion.authenticationWords,
      })
      this.scheduleStatus(completion.pendingPairingId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.isTerminal(error, attempt)) {
        this.clearAttempt()
        this.publish({ status: 'ready', error: message })
      } else {
        this.publish({ status: 'retryable', error: message })
      }
      throw error
    }
  }

  private currentAttempt(): PreparedMobilePairingAttempt | undefined {
    const attempt = this.attempt
    if (attempt === undefined) return undefined
    if (attempt.accountId !== this.requireAccountId()) {
      this.resetAccountScope()
      return undefined
    }
    if (attempt.transmission === 'pending') return attempt
    const expiresAt = attempt.transmission === 'possibly-committed'
      ? attempt.replayExpiresAt ?? attempt.expiresAt
      : attempt.expiresAt
    if (this.now() < expiresAt) return attempt
    this.clearAttempt()
    this.publish({ status: 'ready', error: 'Personal Pairing invitation expired' })
    return undefined
  }

  private isTerminal(error: unknown, attempt: PreparedMobilePairingAttempt): boolean {
    return error instanceof RemoteAccessError
      || (attempt.transmission === 'prepared' && this.now() >= attempt.expiresAt)
  }

  private clearAttempt(): void {
    this.attempt = undefined
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private completeLinkOwned(link: string): Promise<void> {
    const retained = this.currentAttempt()
    if (retained !== undefined && retained.link !== link) {
      throw new Error('Retry the retained Personal Pairing attempt before using another invitation')
    }
    return (async () => {
      const attempt = retained ?? await this.prepareAttempt(link)
      await this.runAttempt(attempt)
    })()
  }

  private resetAccountScope(): void {
    this.clearAttempt()
    this.options.companion?.forgetConnection()
    if (this.options.companion !== undefined) {
      void this.options.companion.releasePairing()
    }
    if (this.options.relay !== this.options.companion) {
      void this.options.relay?.configure(undefined)
    }
    this.accountId = undefined
    this.snapshot = { status: 'ready' }
  }

  private currentAccountId(): PlatformAccountId {
    const snapshot = this.options.installation.getSnapshot()
    if (snapshot.status !== 'signed-in' || snapshot.account === undefined) {
      throw new Error('Mobile Personal Pairing requires a signed-in Platform Account')
    }
    return snapshot.account.id
  }

  private requireAccountId(): PlatformAccountId {
    const current = this.currentAccountId()
    if (this.accountId === undefined) this.accountId = current
    if (this.accountId !== current) throw new Error('Mobile Personal Pairing Account changed')
    return current
  }

  private publish(snapshot: MobilePairingSnapshot): void {
    if (!this.active) return
    this.snapshot = snapshot
    const errors: unknown[] = []
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) {
      console.error('[mobile-personal-pairing] subscriber failures:', new AggregateError(errors))
    }
  }

  private scheduleStatus(pendingPairingId: PendingPairingId): void {
    if (!this.active) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = this.schedule(() => {
      this.timer = undefined
      if (!this.active) return
      void this.exclusive(async () => {
        try {
          const status = await this.options.transport.getMobilePairingStatus({
            authentication: await this.options.installation.authorizeCurrentInstallation(),
            pendingPairingId,
          })
          if (status.status === 'pending') {
            this.scheduleStatus(pendingPairingId)
          } else if (status.status === 'paired') {
            if (this.options.pairingKeys !== undefined) {
              if (this.options.handshake.exportPairingKeyMaterial === undefined) {
                throw new Error('Mobile Pairing handshake cannot export pairing key material')
              }
              const material = this.options.handshake.exportPairingKeyMaterial()
              if (material === undefined) {
                throw new Error('Mobile Pairing handshake exported no pairing key material')
              }
              this.options.pairingKeys.retain(status.pairingId, material)
              material.fill(0)
            }
            if (status.sealedRelayAuthority !== undefined) {
              if (this.options.handshake.openRelayAuthority === undefined || this.options.relay === undefined) {
                throw new Error('Mobile Relay authority has no product lifecycle owner')
              }
              const grant = await this.options.handshake.openRelayAuthority(status.sealedRelayAuthority)
              this.assertActiveAccount()
              await this.options.relay.configure(grant)
              this.assertActiveAccount()
              await this.options.relay.start()
              this.assertActiveAccount()
            }
            this.clearAttempt()
            this.publish({ status: 'paired' })
          } else {
            this.clearAttempt()
            this.publish({ status: 'unavailable', error: 'Desktop rejected Personal Pairing.' })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const attempt = this.attempt
          if (attempt === undefined || this.isTerminal(error, attempt)) {
            this.clearAttempt()
            this.publish({ status: 'ready', error: message })
          } else {
            this.publish({ status: 'retryable', error: message })
          }
        }
      })
    }, this.pollIntervalMs)
  }

  private exclusive(operation: () => Promise<void>): Promise<void> {
    const result = this.serial.then(async () => {
      this.assertActive()
      this.requireAccountId()
      await operation()
    })
    this.serial = result.then(() => undefined, () => undefined)
    return result
  }

  private assertActive(): void {
    if (!this.active) throw new Error('Mobile Personal Pairing is inactive')
  }

  private assertActiveAccount(): void {
    this.assertActive()
    this.requireAccountId()
  }
}

function throwRejected(results: PromiseSettledResult<unknown>[], message: string): void {
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
  if (errors.length > 0) throw new AggregateError(errors, message)
}
