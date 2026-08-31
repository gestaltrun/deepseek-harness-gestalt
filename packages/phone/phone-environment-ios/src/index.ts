/** iOS Runtime and default-Simulator preparation Provider. @module @deepseek-ai/dsh-phone-environment-ios */

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
