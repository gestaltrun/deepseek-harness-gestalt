/** Desktop Installation presentation captured before Platform Account sign-in. */

import {
  parseDesktopInstallationPresentation,
  type DesktopInstallationPresentation,
} from '@deepseek-ai/dsh-platform-account'

/** Host values required for a user-recognizable Desktop Installation presentation. */
export interface DesktopSystemInformation {
  hostname: string
  platform: NodeJS.Platform
}

/** @param information - operating-system hostname and platform. @returns bounded Account presentation. */
export function desktopInstallationPresentation(
  information: DesktopSystemInformation,
): DesktopInstallationPresentation {
  const platform = information.platform === 'darwin'
    ? 'macos'
    : information.platform === 'win32'
      ? 'windows'
      : information.platform === 'linux'
        ? 'linux'
        : undefined
  if (platform === undefined) throw new TypeError('Desktop Account requires macOS, Windows, or Linux')
  return parseDesktopInstallationPresentation({ name: information.hostname, platform })
}
