/** Mobile Personal Pairing state shared by the controller and React view. */

/** Mobile Personal Pairing presentation state. */
export type MobilePairingSnapshot =
  | { status: 'ready'; error?: string }
  | { status: 'completing' }
  | { status: 'retryable'; error: string }
  | {
    status: 'pending'
    deviceName: string
    authenticationWords: readonly [string, string, string, string, string, string]
  }
  | { status: 'paired' }
  | { status: 'unpair-failed'; error: string }
  | { status: 'unavailable'; error: string }

/** Mobile adapter for full-link/QR completion and handshake state. */
export interface MobilePairingActions {
  /** Read the current pairing state, preserving object identity until a transition. */
  getSnapshot(): MobilePairingSnapshot
  /** Subscribe to pairing transitions. */
  subscribe(listener: () => void): () => void
  /** Complete the exact high-entropy link produced by Desktop. */
  completeLink(link: string): void | Promise<void>
  /** Open the browser camera scanner and complete its exact payload. */
  scanQr(video: HTMLVideoElement, signal?: AbortSignal): void | Promise<void>
  /** Retry the retained completion attempt without regenerating handshake material. */
  retryPairing(): void | Promise<void>
  /** Activate this signed-in Mobile lifecycle owner. */
  activate(): Promise<void>
  /** Stop timers and drain in-flight work on sign-out or unmount. */
  deactivate(): Promise<void>
  /**
   * Unpair this installation by attempting every owned cleanup.
   * A rejected cleanup publishes `unpair-failed`, preserves an unresolved product state, and rejects with every failure.
   */
  unpair(): Promise<void>
}
