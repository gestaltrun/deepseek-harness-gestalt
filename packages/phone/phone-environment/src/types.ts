import type { DeviceId } from '@deepseek-ai/dsh-phone-runtime'

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

/** Android SDK source selected by the platform environment Provider. */
export type AndroidSdkSource = 'existing' | 'managed'

/** Immutable preparation facts shown before the Android SDK license is accepted. */
export interface AndroidPreparationPlan {
  readonly sdkRoot: string
  readonly sdkSource: AndroidSdkSource
  readonly avdHome: string
  readonly avdName: string
  readonly abi: 'arm64-v8a' | 'x86_64'
  readonly commandLineToolsVersion: string
  readonly commandLineToolsBytes: number
  readonly packageIds: readonly string[]
  readonly minimumFreeBytes: number
  readonly licenseUrl: string
  readonly components: {
    readonly commandLineTools: boolean
    readonly platformTools: boolean
    readonly emulator: boolean
    readonly systemImage: boolean
    readonly avd: boolean
  }
}

/** Android-specific preparation and runtime states published through the full Host snapshot. */
export type PhoneAndroidState =
  | { readonly kind: 'deferred' }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'checking' }
  | { readonly kind: 'missing'; readonly plan: AndroidPreparationPlan }
  | { readonly kind: 'awaiting-license'; readonly plan: AndroidPreparationPlan }
  | {
    readonly kind: 'downloading'
    readonly plan: AndroidPreparationPlan
    readonly receivedBytes: number
    readonly totalBytes: number
  }
  | {
    readonly kind: 'installing'
    readonly plan: AndroidPreparationPlan
    readonly step: 'licenses' | 'packages'
  }
  | { readonly kind: 'creating-avd'; readonly plan: AndroidPreparationPlan }
  | { readonly kind: 'checking-acceleration'; readonly plan: AndroidPreparationPlan }
  | { readonly kind: 'booting'; readonly plan: AndroidPreparationPlan }
  | {
    readonly kind: 'manual-required'
    readonly plan: AndroidPreparationPlan
    readonly code: 'disk-space' | 'windows-hypervisor' | 'linux-kvm' | 'virtualization'
    readonly message: string
  }
  | {
    readonly kind: 'ready'
    readonly plan: AndroidPreparationPlan
    readonly deviceId?: DeviceId
    readonly running: boolean
  }
  | {
    readonly kind: 'failed'
    readonly plan?: AndroidPreparationPlan
    readonly code: string
    readonly message: string
    readonly retryable: boolean
  }

/** Explicit consent required before Android SDK assets or licenses are installed. */
export interface AndroidPrepareRequest {
  readonly licenseAccepted: true
}

/** Platform Provider registered into the stable phone environment Service. */
export interface AndroidEnvironmentProvider {
  snapshot(): PhoneAndroidState
  refresh(signal?: AbortSignal): Promise<PhoneAndroidState>
  prepare(request: AndroidPrepareRequest, signal?: AbortSignal): Promise<PhoneAndroidState>
  start(signal?: AbortSignal): Promise<PhoneAndroidState>
  cancel(): void
  deactivate(): Promise<void>
  runtimeEnvironment(): Readonly<Record<string, string>>
  onChanged(listener: (state: PhoneAndroidState) => void): () => void
}

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
    readonly android: PhoneAndroidState
    readonly ios: PhonePlatformState
  }
}
