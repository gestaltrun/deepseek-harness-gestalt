/** Node platforms with an official pinned mobilecli 1.0.5 release asset. */
export type MobilecliPlatform = 'darwin' | 'linux' | 'win32'

/** Node architectures with an official pinned mobilecli 1.0.5 release asset. */
export type MobilecliArchitecture = 'arm64' | 'x64'

/** One immutable upstream release asset admitted by the managed installer. */
export interface MobilecliReleaseAsset {
  /** Node platform selecting this asset. */
  readonly platform: MobilecliPlatform
  /** Node architecture selecting this asset. */
  readonly architecture: MobilecliArchitecture
  /** Exact upstream archive filename. */
  readonly name: string
  /** Exact HTTPS URL for the pinned upstream GitHub Release. */
  readonly url: string
  /** Exact archive byte length published by GitHub. */
  readonly bytes: number
  /** Lowercase SHA-256 digest published by GitHub. */
  readonly sha256: string
  /** Executable filename expected inside the single-entry archive. */
  readonly executable: 'mobilecli' | 'mobilecli.exe'
}

/** Runtime source precedence: explicit operator override, managed current, then system discovery. */
export type PhoneRuntimeSource = 'override' | 'managed' | 'system'

/** Candidate discovered before version probing and activation. */
export interface PhoneRuntimeCandidate {
  /** Source that won the fixed precedence order. */
  readonly source: PhoneRuntimeSource
  /** Absolute executable path owned by the source. */
  readonly executablePath: string
}

/** Shared mobilecli runtime state rendered above the platform-specific sections. */
export type PhoneRuntimeState =
  | { readonly kind: 'missing'; readonly targetVersion: string; readonly assetBytes?: number }
  | { readonly kind: 'downloading'; readonly targetVersion: string; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly kind: 'verifying'; readonly targetVersion: string }
  | { readonly kind: 'activating'; readonly targetVersion: string; readonly source: PhoneRuntimeSource }
  | { readonly kind: 'ready'; readonly version: string; readonly source: PhoneRuntimeSource }
  | { readonly kind: 'failed'; readonly targetVersion: string; readonly code: string; readonly message: string }

/** Platform preparation state. Android/iOS tickets extend the deferred arm without changing the shared runtime. */
export type PhonePlatformState =
  | { readonly kind: 'deferred' }
  | { readonly kind: 'unsupported'; readonly reason: string }

/** Complete immutable Host snapshot consumed by the Phone Devices settings client. */
export interface PhoneEnvironmentSnapshot {
  /** Monotonic publication revision. */
  readonly revision: number
  /** Durable user enable gate projected by the Host settings owner. */
  readonly enabled: boolean
  /** Shared mobilecli runtime state. */
  readonly runtime: PhoneRuntimeState
  /** Platform preparation states owned by later Android/iOS tickets. */
  readonly platforms: {
    readonly android: PhonePlatformState
    readonly ios: PhonePlatformState
  }
}
