/** Android SDK and default-emulator preparation Provider. @module @deepseek-ai/dsh-phone-environment-android */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join, resolve } from 'node:path'
import { AndroidEnvironmentManager } from './environment.ts'

export { AndroidEnvironmentError, AndroidEnvironmentManager } from './environment.ts'
export type { AndroidEnvironmentOptions } from './environment.ts'
export {
  ANDROID_API_LEVEL, ANDROID_AVD_NAME, ANDROID_COMMAND_LINE_TOOLS_ASSETS,
  ANDROID_COMMAND_LINE_TOOLS_VERSION, ANDROID_MINIMUM_FREE_BYTES, ANDROID_SDK_LICENSE_URL,
  selectAndroidCommandLineToolsAsset,
} from './manifest.ts'
export { androidSystemImagePackage, planAndroidEnvironment } from './planner.ts'
export type { AndroidCommandRunner, AndroidOwnedProcess } from './process.ts'
export type { AndroidCommandLineToolsAsset, AndroidHostPlan, AndroidInstallationProbe } from './types.ts'

/** Host-private root shared with the stable phone environment Service. */
export interface Config {
  readonly root?: string
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({ root: z.string() })
export const inject = ['phoneEnvironment'] as const
export const name = 'phone-environment-android'

/** Register the Android Provider into the stable full-snapshot owner. */
export function apply(ctx: Context, config: Config = {}): void {
  const root = resolve(config.root ?? join(resolveDshHome(), 'phone'))
  const manager = new AndroidEnvironmentManager({ phoneRoot: root })
  ctx.effect(() => ctx.phoneEnvironment.registerAndroidEnvironment(manager), 'Android phone environment Provider')
  ctx.effect(() => async () => { await manager.deactivate() }, 'Android phone environment teardown')
}
