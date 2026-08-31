import type { IosPreparationPlan, PhoneIosState } from '@deepseek-ai/dsh-phone-environment'
import type { DeviceId } from '@deepseek-ai/dsh-phone-runtime'

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
  readonly udid: DeviceId
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

/** Planner result before any preparation command runs. */
export type IosHostPlan = PhoneIosState

export type { IosPreparationPlan, PhoneIosState }
