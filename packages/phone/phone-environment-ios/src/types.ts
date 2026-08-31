/** One available iOS Simulator runtime reported by simctl. */
export interface IosRuntime {
  readonly identifier: string
  readonly name: string
  readonly version: string
  readonly available: boolean
}

/** One iPhone Simulator device type reported by simctl. */
export interface IosDeviceType {
  readonly identifier: string
  readonly name: string
}

/** One available Simulator instance reported by simctl. */
export interface IosSimulator {
  readonly udid: string
  readonly name: string
  readonly state: string
  readonly available: boolean
  readonly runtimeIdentifier: string
}

/** Complete Xcode observations used to plan one iOS environment operation. */
export interface IosInstallationProbe {
  readonly developerDir: string
  readonly xcodeVersion: string
  readonly licenseAccepted: boolean
  readonly firstLaunchComplete: boolean
  readonly runtimes: readonly IosRuntime[]
  readonly deviceTypes: readonly IosDeviceType[]
  readonly devices: readonly IosSimulator[]
}

/** Immutable Xcode and default-Simulator facts shown by the settings client. */
export interface IosPreparationPlan {
  readonly developerDir: string
  readonly xcodeVersion: string
  readonly simulatorName: string
  readonly runtime?: IosRuntime
  readonly deviceType?: IosDeviceType
}

/** iOS-specific preparation and Simulator lifecycle state. */
export type PhoneIosState =
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'checking' }
  | { readonly kind: 'xcode-missing'; readonly message: string }
  | { readonly kind: 'license-required'; readonly developerDir: string; readonly message: string }
  | {
    readonly kind: 'manual-required'
    readonly code: 'first-launch' | 'xcode-update'
    readonly message: string
    readonly developerDir?: string
  }
  | { readonly kind: 'runtime-missing'; readonly plan: IosPreparationPlan }
  | { readonly kind: 'no-simulator'; readonly plan: IosPreparationPlan }
  | {
    readonly kind: 'preparing'
    readonly plan: IosPreparationPlan
    readonly step: 'downloading-runtime' | 'creating-simulator' | 'booting'
  }
  | {
    readonly kind: 'ready'
    readonly plan: IosPreparationPlan
    readonly deviceId: string
    readonly running: boolean
  }
  | {
    readonly kind: 'failed'
    readonly plan?: IosPreparationPlan
    readonly code: string
    readonly message: string
    readonly retryable: boolean
  }

/** Planner result before any preparation command runs. */
export type IosHostPlan = PhoneIosState
