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

/** Browser-camera QR scanner returning the exact full invitation payload. */
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
  replayExpiresAt?: number
  pendingProjection?: PairingCompletionView
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
export class BrowserCameraPairingQrScanner implements MobilePairingQrScanner {
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
    if (this.accountId !== undefined && this.accountId !== accountId) await this.resetAccountScope()
    this.accountId = accountId
    this.active = true
  }

  async unpair(): Promise<void> {
    await this.exclusive(async () => {
      this.assertActiveAccount()
      this.attempt?.mobileHandshake.fill(0)
      this.clearAttempt()
      const operations: Array<() => void | Promise<void>> = [
        () => this.options.handshake.wipe?.(),
        () => this.options.pairingKeys?.wipe(),
      ]
      if (this.options.companion !== undefined) operations.push(() => this.options.companion?.releasePairing())
      if (this.options.relay !== this.options.companion) {
        operations.push(
          () => this.options.relay?.configure(undefined),
          () => this.options.relay?.stop(),
        )
      }
      try {
        await settleOwnedCleanup(operations, 'Mobile Personal Pairing unpair failed')
      } finally {
        this.publish({ status: 'ready' })
      }
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

  async completeLink(link: string): Promise<void> {
    await this.exclusive(async () => { await this.completeLinkOwned(link) })
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
        mobileHandshake: attempt.mobileHandshake,
      })
      this.assertActiveAccount()
      attempt.pendingProjection = completion
      attempt.transmission = 'pending'
      await this.options.handshake.acceptDesktopHandshake(completion.desktopHandshake)
      this.assertActiveAccount()
      this.publish({
        status: 'pending',
        deviceName: completion.device.name,
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
      let attempt: PreparedMobilePairingAttempt
      try {
        attempt = retained ?? await this.prepareAttempt(link)
      } catch (error) {
        this.publish({ status: 'ready', error: errorMessage(error) })
        throw error
      }
      await this.runAttempt(attempt)
    })()
  }

  private async resetAccountScope(): Promise<void> {
    this.clearAttempt()
    const operations: Array<() => void | Promise<void>> = [() => this.options.companion?.forgetConnection()]
    if (this.options.companion !== undefined) operations.push(() => this.options.companion?.releasePairing())
    if (this.options.relay !== this.options.companion) operations.push(() => this.options.relay?.configure(undefined))
    try {
      await settleOwnedCleanup(operations, 'Mobile Personal Pairing Account reset failed')
    } finally {
      this.accountId = undefined
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
