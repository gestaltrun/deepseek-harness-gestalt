import type { AndroidPreparationPlan } from '@deepseek-ai/dsh-phone-environment'

/** Host tuples supported by Google's current command-line tools and Emulator. */
export type AndroidHostTuple =
  | { readonly platform: 'darwin'; readonly architecture: 'arm64' | 'x64' }
  | { readonly platform: 'linux' | 'win32'; readonly architecture: 'x64' }

/** One pinned Google command-line tools archive. */
export interface AndroidCommandLineToolsAsset {
  readonly platform: AndroidHostTuple['platform']
  readonly architecture: AndroidHostTuple['architecture']
  readonly name: string
  readonly url: string
  readonly bytes: number
  readonly sha256: string
}

/** Filesystem observations used to build one preparation plan. */
export interface AndroidInstallationProbe {
  readonly sdkRoot: string
  readonly sdkSource: 'existing' | 'managed'
  readonly commandLineTools: boolean
  readonly platformTools: boolean
  readonly emulator: boolean
  readonly systemImage: boolean
  readonly avd: boolean
}

/** Planner result, either a truthful plan or a stable unsupported reason. */
export type AndroidHostPlan =
  | { readonly kind: 'supported'; readonly asset: AndroidCommandLineToolsAsset; readonly plan: AndroidPreparationPlan }
  | { readonly kind: 'unsupported'; readonly reason: string }
