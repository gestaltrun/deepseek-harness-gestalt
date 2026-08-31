/** iOS Runtime and default-Simulator preparation Provider. @module @deepseek-ai/dsh-phone-environment-ios */

import { Context } from '@deepseek-ai/cordis'
import { IosEnvironmentManager } from './environment.ts'

export { IosEnvironmentError, IosEnvironmentManager } from './environment.ts'
export type { IosEnvironmentOptions } from './environment.ts'
export { IOS_SIMULATOR_NAME, planIosEnvironment } from './planner.ts'
export {
  createNodeIosCommandRunner, nodeIosCommandRunner,
} from './process.ts'
export type { IosCommandOptions, IosCommandResult, IosCommandRunner } from './process.ts'
export type {
  IosDeviceType, IosHostPlan, IosInstallationProbe, IosPreparationPlan,
  IosRuntime, IosSimulator, PhoneIosState,
} from './types.ts'

export const inject = ['phoneEnvironment']
export const name = 'phone-environment-ios'

/** Register the iOS Provider into the stable full-snapshot owner. */
export function apply(ctx: Context): void {
  const manager = new IosEnvironmentManager({
    reportError: (error) => { ctx.logger.error(error) },
  })
  ctx.effect(() => ctx.phoneEnvironment.registerIosEnvironment(manager), 'iOS phone environment Provider')
  ctx.effect(() => async () => { await manager.deactivate() }, 'iOS phone environment teardown')
}
