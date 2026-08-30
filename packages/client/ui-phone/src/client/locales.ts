/** `settings.phone-devices` namespace dictionaries. */

/** Dictionary namespace owned by the Phone Devices settings section. */
export const NS = 'settings.phone-devices'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  nav: '手机设备',
  title: '手机设备',
  intro: '把 Android / iOS 模拟器与 USB 真机接入会话，供 Agent 操作、你在侧栏观看并接管。这与「移动伴侣」不同：伴侣是人用手机连桌面，这里是设备被控调试。',
} satisfies Record<string, string>

/** The Phone Devices settings namespace key union. */
export type PhoneSettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  nav: 'Phone Devices',
  title: 'Phone Devices',
  intro: 'Attach Android / iOS simulators and USB handsets to the session so the agent can operate them and you can watch or take over in the sidebar. This is not Mobile Companion: Companion is a person connecting a phone to the desktop; this page is device-under-test debugging.',
} satisfies Record<PhoneSettingsKey, string>
