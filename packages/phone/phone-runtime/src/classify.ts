/**
 * Pattern classification of free-form mobilecli failure output onto the closed
 * real-device arm union. Both failure carriers — the one-shot agent command's
 * stderr/stdout and upstream JSON-RPC error messages — funnel through here so
 * every real-device path reports the same structured arms.
 * @module @deepseek-ai/dsh-phone-runtime/classify
 */

import { PhoneDevicesError } from './errors.ts'
import type { PhoneRealDeviceIssue } from './types.ts'

/**
 * Arms in priority order; the first match wins. An expired profile outranks
 * certificate wording because the expiry names the root cause, while a bare
 * signing-identity complaint without expiry text stays `cert-untrusted`.
 */
const ARMS: readonly {
  readonly issue: PhoneRealDeviceIssue
  readonly matches: (text: string) => boolean
}[] = [
  { issue: 'device-locked', matches: text => /locked|passcode|unlock/i.test(text) },
  { issue: 'profile-expired', matches: text => /profile/i.test(text) && /expir/i.test(text) },
  { issue: 'cert-untrusted', matches: text => /untrusted|not trusted|developer mode|signing (identity|certificate)|codesign/i.test(text) },
  { issue: 'tunnel-failed', matches: text => /tunnel/i.test(text) },
  { issue: 'device-unplugged', matches: text => /unplugged|disconnect|lost connection|cable|not connected/i.test(text) },
]

/**
 * Name the structured real-device failure arm in one free-form failure text.
 * @param text - Combined failure output, exactly as mobilecli reported it.
 * @returns the first matching arm, or `undefined` when the text names no arm
 *   and the failure stays on its transport-level code.
 */
export function classifyRealDeviceIssue(text: string): PhoneRealDeviceIssue | undefined {
  for (const arm of ARMS) {
    if (arm.matches(text)) return arm.issue
  }
  return undefined
}

/**
 * Build the structured failure for one classified text, or `undefined` when
 * the text names no arm.
 * @param message - Complete failure description carried by the built error.
 * @returns the `PHONE_REAL_DEVICE_ISSUE` failure carrying the matched arm on
 *   `issue`, or `undefined` to let the caller's transport-level code stand.
 */
export function realDeviceIssueError(message: string): PhoneDevicesError | undefined {
  const issue = classifyRealDeviceIssue(message)
  return issue === undefined
    ? undefined
    : new PhoneDevicesError('PHONE_REAL_DEVICE_ISSUE', message, { issue })
}
