import {
  parseMobileInstallationPresentation,
  type MobileInstallationPresentation,
} from '@deepseek-ai/dsh-platform-account'

/** Device information needed to bind presentation to a Mobile Account Session. */
export interface MobileDeviceInformation {
  name?: string
  model: string
  platform: 'ios' | 'android' | 'web'
  operatingSystem: 'ios' | 'android' | 'windows' | 'mac' | 'unknown'
}

/**
 * Project native device information into authenticated Mobile Installation presentation.
 * @param information - current device result from the Capacitor Device adapter.
 * @returns recognizable name and Mobile operating-system family.
 */
export function mobileInstallationPresentation(
  information: MobileDeviceInformation,
): MobileInstallationPresentation {
  const platform = information.platform === 'ios' || information.platform === 'android'
    ? information.platform
    : information.operatingSystem
  if (platform !== 'ios' && platform !== 'android') {
    throw new TypeError('Mobile Companion requires an iOS or Android Installation')
  }
  const name = information.name?.trim() === '' || information.name === undefined
    ? information.model
    : information.name
  return parseMobileInstallationPresentation({ name, platform })
}
