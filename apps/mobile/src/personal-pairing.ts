/** Signed-in Mobile Personal Pairing controller over the public Remote Access transport. */

import {
  PAIRING_REPLAY_RETENTION_MS,
  RemoteAccessError,
  deriveAuthenticationWords,
  parsePairingChallengeId,
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
import { BrowserQRCodeReader } from '@zxing/browser'
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
  /** Prepare Mobile XKpsk3 message 1 from an endpoint-owned opaque invitation. */
  beginEndpointInvitation?(invitationPayload: Uint8Array): Promise<Uint8Array>
  /** Consume the Desktop handshake response before exposing authentication words. */
  acceptDesktopHandshake(desktopHandshake: Uint8Array): Promise<void>
  /** @returns Mobile message 3 for a three-message handshake, or undefined for development keyless pairing. */
  exportFinishMessage?(): Uint8Array | undefined
  /** @returns public completed XKpsk3 authentication hash. */
  exportAuthenticationHash?(): Uint8Array
  /** Open Mobile-specific Relay authority sealed to this Personal Pairing. */
  openRelayAuthority?(sealedAuthority: Uint8Array): Promise<RelayCredentialGrant>
  /** Open and persist one-shot authority before invitation state is erased. */
  openRelayAuthorityDurably?(
    sealedAuthority: Uint8Array,
    persist: (grant: RelayCredentialGrant, reconnectState: Uint8Array, attachmentKey: Uint8Array) => Promise<void>,
  ): Promise<RelayCredentialGrant>
  /** @returns endpoint-local XKpsk3 crash recovery before confirmation settles. */
  exportRecoveryState?(): Uint8Array
  /** Restore endpoint-local XKpsk3 state after process restart. */
  restoreRecoveryState?(recovery: Uint8Array): void
  /**
   * Export the independent pairing key retained after the Desktop handshake.
   * @returns copy of at least 32 bytes, or undefined before activation.
   */
  exportPairingKeyMaterial?(): Uint8Array | undefined
  /** @returns Mobile static reconnect state after opening Relay authority. */
  exportReconnectState?(): Uint8Array
  /** @returns endpoint-secret attachment key after opening sealed Relay authority. */
  exportAttachmentKey?(): Uint8Array
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
  /** Atomically retain reconnect state and its Mobile Relay authority. */
  retainConfirmedPairing?(
    pairingId: PersonalPairingId,
    reconnectState: Uint8Array,
    attachmentKey: Uint8Array,
    grant: RelayCredentialGrant,
  ): void
  /** Select and load one signed-in Account scope before Relay attachment. */
  selectAccount?(accountId: PlatformAccountId): Promise<void>
  /** Retain the Mobile-only Relay grant beside its reconnect state. */
  retainRelayAuthority?(pairingId: PersonalPairingId, grant: RelayCredentialGrant): void
  /** @returns latest retained Mobile Relay grant for this Account. */
  relayAuthority?(): RelayCredentialGrant | undefined
  /** @returns retained confirmed Personal Pairing for this Account. */
  retainedPairingId?(): PersonalPairingId | undefined
  /** Persist one in-flight endpoint pairing before its next external effect. */
  retainEndpointRecovery?(recovery: MobileEndpointPairingRecovery): void
  /** @returns an Account-scoped endpoint pairing recovery copy. */
  endpointRecovery?(): MobileEndpointPairingRecovery | undefined
  /** Remove settled or rejected endpoint recovery. */
  clearEndpointRecovery?(): void
  /** Wait until queued durable writes settle. */
  flush?(): Promise<void>
  /** Zero every retained pairing key. */
  wipe(): void
}

/** Account-scoped Mobile crash recovery for one endpoint-owned pairing transaction. */
export interface MobileEndpointPairingRecovery {
  link: string
  expiresAt: number
  accountId: PlatformAccountId
  completionId: PairingCompletionId
  mobileHandshake: Uint8Array
  transmission: PreparedMobilePairingAttempt['transmission']
  endpointChallengeId: ReturnType<typeof parsePairingChallengeId>
  handshakeRecovery: Uint8Array
  replayExpiresAt?: number
  endpointHandshakeFinished: boolean
}

/** Native-product browser-camera QR scanner returning the exact full invitation payload. */
interface MobilePairingQrScanner {
  /** @returns exact full invitation payload decoded from the camera preview. */
  scan(video: HTMLVideoElement, signal?: AbortSignal): Promise<string>
}

interface PreparedMobilePairingAttempt {
  link: string
  expiresAt: number
  accountId: PlatformAccountId
  completionId: PairingCompletionId
  mobileHandshake: Uint8Array
  transmission: 'prepared' | 'possibly-committed' | 'pending'
  endpointChallengeId?: ReturnType<typeof parsePairingChallengeId>
  endpointHandshakeFinished?: boolean
  replayExpiresAt?: number
  pendingProjection?: PairingCompletionView
  confirmed?: {
    pairingId: PersonalPairingId
    sealedRelayAuthority: Uint8Array
    reconnectState: Uint8Array
    attachmentKey: Uint8Array
    grant: RelayCredentialGrant
    persisted: boolean
  }
}

interface BrowserQrReader {
  scan(
    video: HTMLVideoElement,
    callback: (
      result: { getText(): string } | undefined,
      error: Error | undefined,
      controls: BrowserQrScannerControls,
    ) => void,
    finalized: (error?: Error) => void,
  ): BrowserQrScannerControls
}

interface BrowserQrScannerControls {
  stop(): void
}

/** Browser-camera scanner for the same complete invitation accepted by paste. */
export class NativeMobilePairingQrScanner implements MobilePairingQrScanner {
  private readonly mediaDevices: MediaDevices | undefined
  private readonly reader: BrowserQrReader

  /** @param options - browser camera and QR decoder adapters. */
  constructor(options: { mediaDevices?: MediaDevices; reader?: BrowserQrReader } = {}) {
    this.mediaDevices = options.mediaDevices ?? globalThis.navigator.mediaDevices
    this.reader = options.reader ?? new BrowserQRCodeReader()
  }

  async scan(video: HTMLVideoElement, signal?: AbortSignal): Promise<string> {
    if (this.mediaDevices?.getUserMedia === undefined) {
      throw new Error('Camera scanning is not supported by this browser')
    }
    throwIfCameraAborted(signal)
    let stream: MediaStream
    try {
      stream = await acquireCameraStream(
        this.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' } },
        }),
        signal,
      )
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        throw new Error('Camera permission was denied', { cause: error })
      }
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        throw new Error('No camera is available for Personal Pairing', { cause: error })
      }
      throw new Error(`Camera access failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    const cancel = (): void => { for (const track of stream.getTracks()) track.stop() }
    signal?.addEventListener('abort', cancel, { once: true })
    let controls: BrowserQrScannerControls | undefined
    let scanAbort: (() => void) | undefined
    try {
      video.srcObject = stream
      await settleBeforeCameraAbort(video.play(), signal)
      const decoded = await new Promise<{ getText(): string }>((resolve, reject) => {
        scanAbort = (): void => {
          controls?.stop()
          reject(new Error('Personal Pairing camera scan was cancelled'))
        }
        signal?.addEventListener('abort', scanAbort, { once: true })
        try {
          controls = this.reader.scan(
            video,
            (result, _error, callbackControls) => {
              if (result === undefined) return
              callbackControls.stop()
              resolve(result)
            },
            (error) => {
              if (error !== undefined) reject(error)
            },
          )
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
        }
      })
      throwIfCameraAborted(signal)
      const payload = decoded.getText()
      if (payload === '') throw new TypeError('Personal Pairing QR payload must be non-empty')
      return payload
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (scanAbort !== undefined) signal?.removeEventListener('abort', scanAbort)
      controls?.stop()
      cancel()
      video.pause()
      video.srcObject = null
    }
  }
}

/** Mobile controller construction inputs. */
export interface MobilePairingControllerOptions {
  installation: Pick<PlatformAccountInstallation, 'authorizeCurrentInstallation' | 'getSnapshot'>
  transport: RemoteAccessTransport
  handshake: MobilePairingHandshakeClient
  scanner: MobilePairingQrScanner
  /** Product Relay lifecycle receiving only Mobile-specific authority. */
  relay?: {
    configure(grant?: RelayCredentialGrant): void | Promise<void>
    start(): Promise<void>
    stop(): Promise<void>
  }
  /** Process-owned foreground Relay lifecycle. */
  companion?: MobilePairingLifecycleOwner
  /** Optional retention sink receiving confirmed pairing key material for pairing-scoped consumers. */
  attachmentKeys?: MobilePairingKeyRetention
  /** Delete the pairing-owned projection only after Platform revocation succeeds. */
  releaseProjectionAuthority?: () => Promise<void>
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
  private pairingId: PersonalPairingId | undefined
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
    if (this.accountId !== undefined && this.accountId !== accountId) await this.resetAccountScope()
    this.accountId = accountId
    await this.options.attachmentKeys?.selectAccount?.(accountId)
    this.pairingId = this.options.attachmentKeys?.retainedPairingId?.()
    this.active = true
    const recovery = this.options.attachmentKeys?.endpointRecovery?.()
    if (recovery !== undefined) {
      if (recovery.accountId !== accountId || this.now() >= (recovery.replayExpiresAt ?? recovery.expiresAt)) {
        recovery.mobileHandshake.fill(0)
        recovery.handshakeRecovery.fill(0)
        this.options.attachmentKeys?.clearEndpointRecovery?.()
        await this.options.attachmentKeys?.flush?.()
      } else {
        if (this.options.handshake.restoreRecoveryState === undefined) {
          throw new Error('Mobile endpoint pairing recovery has no handshake owner')
        }
        this.options.handshake.restoreRecoveryState(recovery.handshakeRecovery)
        recovery.handshakeRecovery.fill(0)
        const restoredAttempt: PreparedMobilePairingAttempt = {
          link: recovery.link, expiresAt: recovery.expiresAt, accountId: recovery.accountId,
          completionId: recovery.completionId, mobileHandshake: recovery.mobileHandshake,
          transmission: recovery.transmission, endpointChallengeId: recovery.endpointChallengeId,
          ...(recovery.replayExpiresAt === undefined ? {} : { replayExpiresAt: recovery.replayExpiresAt }),
          endpointHandshakeFinished: recovery.endpointHandshakeFinished,
        }
        this.attempt = restoredAttempt
        if (recovery.transmission === 'pending') this.scheduleEndpointStatus(recovery.completionId)
        else await this.runAttempt(restoredAttempt)
      }
    }
    const restoredGrant = this.options.attachmentKeys?.relayAuthority?.()
    if (restoredGrant !== undefined && this.options.relay !== undefined) {
      await this.options.relay.configure(restoredGrant)
      await this.options.relay.start()
    }
  }

  async unpair(): Promise<void> {
    await this.exclusive(async () => {
      this.assertActiveAccount()
      const settleStage = async (operations: ReadonlyArray<() => void | Promise<void>>): Promise<void> => {
        try {
          await settleOwnedCleanup(operations, 'Mobile Personal Pairing unpair failed')
        } catch (error) {
          this.publish({ status: 'unpair-failed', error: errorMessage(error) })
          throw error
        }
      }
      await settleStage([
        async () => {
          if (this.pairingId === undefined) return
          await this.options.transport.revokeMobilePersonalPairing({
            authentication: await this.options.installation.authorizeCurrentInstallation(),
            pairingId: this.pairingId,
          })
        },
      ])
      await settleStage([
        () => this.options.releaseProjectionAuthority?.(),
      ])
      this.attempt?.mobileHandshake.fill(0)
      this.clearAttempt()
      const operations: Array<() => void | Promise<void>> = [
        () => this.options.handshake.wipe?.(),
        () => this.options.attachmentKeys?.wipe(),
        () => this.options.attachmentKeys?.flush?.(),
      ]
      if (this.options.companion !== undefined) operations.push(() => this.options.companion?.releasePairing())
      if (this.options.relay !== this.options.companion) {
        operations.push(
          () => this.options.relay?.configure(undefined),
          () => this.options.relay?.stop(),
        )
      }
      await settleStage(operations)
      this.pairingId = undefined
      this.publish({ status: 'ready' })
    })
  }

  async deactivate(): Promise<void> {
    this.active = false
    const transaction = (async () => {
      await this.lifecycleBarrier
      const admitted = await Promise.allSettled([this.serial])
      const cleanup = await Promise.allSettled([
        this.resetAccountScope(),
        this.options.relay?.stop() ?? Promise.resolve(),
      ])
      throwRejected([...admitted, ...cleanup], 'Mobile Personal Pairing deactivation failed')
    })()
    this.lifecycleBarrier = transaction.then(() => undefined, () => undefined)
    await transaction
  }

  async completeLink(link: string, signal?: AbortSignal): Promise<void> {
    requirePairingSignal(signal)
    await this.exclusive(async () => {
      requirePairingSignal(signal)
      await this.completeLinkOwned(link, signal)
      requirePairingSignal(signal)
    })
  }

  async scanQr(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
    await this.exclusive(async () => {
      let payload: string
      try {
        payload = await this.options.scanner.scan(video, signal)
      } catch (error) {
        this.publish({ status: 'ready', error: errorMessage(error) })
        throw error
      }
      requirePairingSignal(signal)
      this.assertActiveAccount()
      await this.completeLinkOwned(payload, signal)
    })
  }

  async retryPairing(): Promise<void> {
    await this.exclusive(async () => {
      const attempt = this.currentAttempt()
      if (attempt === undefined) throw new Error('No retryable Personal Pairing attempt is available')
      await this.runAttempt(attempt)
    })
  }

  private async prepareAttempt(link: string, signal?: AbortSignal): Promise<PreparedMobilePairingAttempt> {
    requirePairingSignal(signal)
    const endpoint = parseEndpointInvitation(link)
    if (endpoint !== undefined) {
      if (this.now() >= endpoint.expiresAt) throw new Error('Personal Pairing invitation expired')
      if (this.options.handshake.beginEndpointInvitation === undefined) {
        throw new Error('Endpoint-owned Personal Pairing handshake is unavailable')
      }
      const message1 = await this.options.handshake.beginEndpointInvitation(endpoint.payload)
      requirePairingSignal(signal)
      const attempt: PreparedMobilePairingAttempt = {
        link, expiresAt: endpoint.expiresAt, accountId: this.requireAccountId(),
        completionId: `snow-${crypto.randomUUID()}` as PairingCompletionId,
        mobileHandshake: message1, transmission: 'prepared', endpointChallengeId: endpoint.challengeId,
      }
      this.attempt = attempt
      await this.checkpointEndpointAttempt(attempt)
      requirePairingSignal(signal)
      return attempt
    }
    const invitation = parsePairingInvitationLink(link)
    if (this.now() >= invitation.expiresAt) throw new Error('Personal Pairing invitation expired')
    const prepared = await this.options.handshake.begin(link)
    requirePairingSignal(signal)
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

  private async runAttempt(attempt: PreparedMobilePairingAttempt, signal?: AbortSignal): Promise<void> {
    this.publish({ status: 'completing' })
    try {
      const authentication = await this.options.installation.authorizeCurrentInstallation()
      requirePairingSignal(signal)
      this.assertActiveAccount()
      attempt.transmission = 'possibly-committed'
      attempt.replayExpiresAt = this.now() + PAIRING_REPLAY_RETENTION_MS
      if (attempt.endpointChallengeId !== undefined) {
        await this.checkpointEndpointAttempt(attempt)
        requirePairingSignal(signal)
        const pending = await this.options.transport.submitEndpointMessage1({
          authentication, challengeId: attempt.endpointChallengeId, completionId: attempt.completionId,
          message1: attempt.mobileHandshake,
        })
        requirePairingSignal(signal)
        this.assertActiveAccount()
        attempt.transmission = 'pending'
        await this.checkpointEndpointAttempt(attempt)
        requirePairingSignal(signal)
        this.publish({ status: 'completing' })
        this.scheduleEndpointStatus(attempt.completionId)
        void pending
        return
      }
      const completion = await this.options.transport.completeChallenge({
        authentication,
        completionId: attempt.completionId,
        oneTimeLink: attempt.link,
        mobileHandshake: attempt.mobileHandshake,
      })
      requirePairingSignal(signal)
      this.assertActiveAccount()
      attempt.pendingProjection = completion
      attempt.transmission = 'pending'
      await this.options.handshake.acceptDesktopHandshake(completion.desktopHandshake)
      requirePairingSignal(signal)
      this.assertActiveAccount()
      const mobileFinish = this.options.handshake.exportFinishMessage?.()
      let finished = completion
      if (mobileFinish !== undefined) {
        try {
          const finishAuthentication = await this.options.installation.authorizeCurrentInstallation()
          requirePairingSignal(signal)
          finished = await this.options.transport.finishChallenge({
            authentication: finishAuthentication,
            pendingPairingId: completion.pendingPairingId,
            mobileFinish,
          })
          requirePairingSignal(signal)
        } finally {
          mobileFinish.fill(0)
        }
      }
      this.assertActiveAccount()
      attempt.pendingProjection = finished
      this.publish({
        status: 'pending',
        deviceName: finished.device.name,
        authenticationWords: finished.authenticationWords,
      })
      this.scheduleStatus(finished.pendingPairingId)
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

  private scheduleEndpointStatus(completionId: PairingCompletionId): void {
    if (!this.active) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = this.schedule(() => {
      this.timer = undefined
      if (!this.active) return
      void this.exclusive(async () => {
        try {
          const authentication = await this.options.installation.authorizeCurrentInstallation()
          const status = await this.options.transport.getEndpointPairingStatus({ authentication, completionId })
          this.assertActiveAccount()
          if (status.stage === 'awaiting-desktop' || status.stage === 'awaiting-authority') {
            this.scheduleEndpointStatus(completionId)
            return
          }
          if (status.stage === 'message2') {
            const attempt = this.currentAttempt()
            if (attempt === undefined) throw new Error('Mobile Personal Pairing has no retained endpoint attempt')
            if (!attempt.endpointHandshakeFinished) {
              await this.options.handshake.acceptDesktopHandshake(status.message2)
              attempt.endpointHandshakeFinished = true
              await this.checkpointEndpointAttempt(attempt)
            }
            const message3 = this.options.handshake.exportFinishMessage?.()
            const hash = this.options.handshake.exportAuthenticationHash?.()
            if (message3 === undefined || hash === undefined) {
              throw new Error('Endpoint-owned Personal Pairing did not complete XKpsk3')
            }
            try {
              await this.options.transport.submitEndpointMessage3({ authentication, completionId, message3 })
            } finally {
              message3.fill(0)
            }
            this.publish({
              status: 'pending', deviceName: status.device.name,
              authenticationWords: deriveAuthenticationWords(hash),
            })
            hash.fill(0)
            this.scheduleEndpointStatus(completionId)
            return
          }
          if (status.stage === 'rejected') {
            this.clearAttempt()
            this.publish({ status: 'unavailable', error: 'Desktop rejected Personal Pairing.' })
            return
          }
          if ((this.options.handshake.openRelayAuthority === undefined
            && this.options.handshake.openRelayAuthorityDurably === undefined) || this.options.relay === undefined) {
            throw new Error('Mobile Relay authority has no product lifecycle owner')
          }
          const attempt = this.currentAttempt()
          if (attempt === undefined) throw new Error('Mobile Personal Pairing has no retained confirmation attempt')
          const confirmed = await this.prepareConfirmedEndpointAttempt(
            attempt, status.pairingId, status.sealedRelayAuthority,
          )
          if (!confirmed.persisted) {
            if (this.options.attachmentKeys?.retainConfirmedPairing !== undefined) {
              this.options.attachmentKeys.retainConfirmedPairing(
                confirmed.pairingId, confirmed.reconnectState, confirmed.attachmentKey, confirmed.grant,
              )
            } else {
              this.options.attachmentKeys?.retain(confirmed.pairingId, confirmed.attachmentKey)
              this.options.attachmentKeys?.retainRelayAuthority?.(confirmed.pairingId, confirmed.grant)
            }
            await this.options.attachmentKeys?.flush?.()
            confirmed.persisted = true
          }
          await this.options.relay.configure(confirmed.grant)
          await this.options.relay.start()
          this.pairingId = confirmed.pairingId
          this.clearAttempt()
          this.publish({ status: 'paired' })
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
    this.timer.unref()
  }

  private currentAttempt(): PreparedMobilePairingAttempt | undefined {
    const attempt = this.attempt
    if (attempt === undefined) return undefined
    this.requireAccountId()
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
    this.clearVolatileAttempt()
    this.options.attachmentKeys?.clearEndpointRecovery?.()
  }

  private clearVolatileAttempt(): void {
    this.attempt?.mobileHandshake.fill(0)
    this.attempt?.confirmed?.sealedRelayAuthority.fill(0)
    this.attempt?.confirmed?.reconnectState.fill(0)
    this.attempt?.confirmed?.attachmentKey.fill(0)
    this.attempt = undefined
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private async prepareConfirmedEndpointAttempt(
    attempt: PreparedMobilePairingAttempt,
    pairingId: PersonalPairingId,
    sealedRelayAuthority: Uint8Array,
  ): Promise<NonNullable<PreparedMobilePairingAttempt['confirmed']>> {
    const retained = attempt.confirmed
    if (retained !== undefined) {
      if (retained.pairingId !== pairingId || !sameBytes(retained.sealedRelayAuthority, sealedRelayAuthority)) {
        throw new Error('Confirmed Personal Pairing changed during Mobile retry')
      }
      return retained
    }
    let durableReconnectState: Uint8Array | undefined
    let durableAttachmentKey: Uint8Array | undefined
    const attachmentKeys = this.options.attachmentKeys
    let grant: RelayCredentialGrant | undefined
    if (this.options.handshake.openRelayAuthorityDurably === undefined
      || attachmentKeys?.retainConfirmedPairing === undefined) {
      grant = await this.options.handshake.openRelayAuthority?.(sealedRelayAuthority)
    } else {
      grant = await this.options.handshake.openRelayAuthorityDurably(
        sealedRelayAuthority, async (openedGrant, reconnectState, attachmentKey) => {
          durableReconnectState = reconnectState.slice()
          durableAttachmentKey = attachmentKey.slice()
          attachmentKeys.retainConfirmedPairing?.(pairingId, reconnectState, attachmentKey, openedGrant)
          await attachmentKeys.flush?.()
        },
      )
    }
    if (grant === undefined) throw new Error('Mobile Relay authority has no product lifecycle owner')
    const reconnectState = durableReconnectState ?? this.options.handshake.exportReconnectState?.()
    if (reconnectState === undefined) throw new Error('Mobile Snow reconnect state is unavailable')
    const attachmentKey = durableAttachmentKey ?? this.options.handshake.exportAttachmentKey?.()
    if (attachmentKey === undefined) throw new Error('Mobile Snow attachment key is unavailable')
    attempt.confirmed = {
      pairingId,
      sealedRelayAuthority: sealedRelayAuthority.slice(),
      reconnectState: reconnectState.slice(),
      attachmentKey: attachmentKey.slice(),
      grant: { ...grant },
      persisted: durableReconnectState !== undefined,
    }
    reconnectState.fill(0)
    attachmentKey.fill(0)
    return attempt.confirmed
  }

  private completeLinkOwned(link: string, signal?: AbortSignal): Promise<void> {
    const retained = this.currentAttempt()
    if (retained !== undefined && retained.link !== link) {
      throw new Error('Retry the retained Personal Pairing attempt before using another invitation')
    }
    return (async () => {
      let attempt: PreparedMobilePairingAttempt
      try {
        attempt = retained ?? await this.prepareAttempt(link, signal)
        requirePairingSignal(signal)
      } catch (error) {
        this.publish({ status: 'ready', error: errorMessage(error) })
        throw error
      }
      await this.runAttempt(attempt, signal)
      requirePairingSignal(signal)
    })()
  }

  private async resetAccountScope(): Promise<void> {
    this.clearVolatileAttempt()
    const operations: Array<() => void | Promise<void>> = [() => this.options.companion?.forgetConnection()]
    if (this.options.companion !== undefined) operations.push(() => this.options.companion?.releasePairing())
    if (this.options.relay !== this.options.companion) operations.push(() => this.options.relay?.configure(undefined))
    operations.push(() => this.options.attachmentKeys?.flush?.())
    try {
      await settleOwnedCleanup(operations, 'Mobile Personal Pairing Account reset failed')
    } finally {
      this.accountId = undefined
      this.pairingId = undefined
      this.snapshot = { status: 'ready' }
    }
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

  private async checkpointEndpointAttempt(attempt: PreparedMobilePairingAttempt): Promise<void> {
    if (attempt.endpointChallengeId === undefined) return
    if (this.options.handshake.exportRecoveryState === undefined
      || this.options.attachmentKeys?.retainEndpointRecovery === undefined) {
      throw new Error('Mobile endpoint pairing has no durable recovery owner')
    }
    const handshakeRecovery = this.options.handshake.exportRecoveryState()
    try {
      await this.options.attachmentKeys.selectAccount?.(attempt.accountId)
      this.options.attachmentKeys.retainEndpointRecovery({
        link: attempt.link, expiresAt: attempt.expiresAt, accountId: attempt.accountId,
        completionId: attempt.completionId, mobileHandshake: attempt.mobileHandshake,
        transmission: attempt.transmission, endpointChallengeId: attempt.endpointChallengeId,
        handshakeRecovery,
        ...(attempt.replayExpiresAt === undefined ? {} : { replayExpiresAt: attempt.replayExpiresAt }),
        endpointHandshakeFinished: attempt.endpointHandshakeFinished ?? false,
      })
      await this.options.attachmentKeys.flush?.()
    } finally { handshakeRecovery.fill(0) }
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
            if (this.options.attachmentKeys !== undefined) {
              if (this.options.handshake.exportPairingKeyMaterial === undefined) {
                throw new Error('Mobile Pairing handshake cannot export pairing key material')
              }
              const material = this.options.handshake.exportPairingKeyMaterial()
              if (material === undefined) {
                throw new Error('Mobile Pairing handshake exported no pairing key material')
              }
              this.options.attachmentKeys.retain(status.pairingId, material)
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
            this.pairingId = status.pairingId
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

function parseEndpointInvitation(link: string): {
  challengeId: ReturnType<typeof parsePairingChallengeId>
  expiresAt: number
  payload: Uint8Array
} | undefined {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return undefined
  }
  const encoded = url.searchParams.get('payload')
  if (encoded === null) return undefined
  const expiresAt = Number(url.searchParams.get('expires'))
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new TypeError('Endpoint Pairing invitation expiry is invalid')
  }
  if (url.searchParams.get('protocol') !== '1') {
    throw new TypeError('Endpoint Pairing invitation protocol is unsupported')
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length % 4 === 1) {
    throw new TypeError('Endpoint Pairing invitation payload must be canonical base64url')
  }
  const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - encoded.length % 4) % 4))
  const payload = Uint8Array.from(binary, value => value.charCodeAt(0))
  return {
    challengeId: parsePairingChallengeId(url.searchParams.get('challenge')),
    expiresAt,
    payload,
  }
}

function throwRejected(results: PromiseSettledResult<unknown>[], message: string): void {
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
  if (errors.length > 0) throw new AggregateError(errors, message)
}

async function settleOwnedCleanup(
  operations: ReadonlyArray<() => void | Promise<void>>,
  message: string,
): Promise<void> {
  const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)))
  throwRejected(results, message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requirePairingSignal(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted()
}

function throwIfCameraAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error('Personal Pairing camera scan was cancelled')
}

function settleBeforeCameraAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(new Error('Personal Pairing camera scan was cancelled'))
  return new Promise<T>((resolve, reject) => {
    const cancelled = (): void => { reject(new Error('Personal Pairing camera scan was cancelled')) }
    signal.addEventListener('abort', cancelled, { once: true })
    void operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', cancelled) })
  })
}

function acquireCameraStream(operation: Promise<MediaStream>, signal: AbortSignal | undefined): Promise<MediaStream> {
  if (signal === undefined) return operation
  return new Promise<MediaStream>((resolve, reject) => {
    let cancelled = signal.aborted
    const cancel = (): void => {
      cancelled = true
      reject(new Error('Personal Pairing camera scan was cancelled'))
    }
    if (cancelled) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    void operation.then(
      (stream) => {
        signal.removeEventListener('abort', cancel)
        if (cancelled || signal.aborted) {
          for (const track of stream.getTracks()) track.stop()
          return
        }
        resolve(stream)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', cancel)
        if (!cancelled) reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
      },
    )
  })
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}
