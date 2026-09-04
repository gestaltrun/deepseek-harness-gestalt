/**
 * Durable PNG stills under `$DSH_HOME/phone/screenshots`. The CLI still
 * writes a temp file; this module copies the validated bytes onto the
 * owner-only home path the Service returns.
 * @module @deepseek-ai/dsh-phone-runtime/screenshot-store
 */

import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { PhoneDevicesError } from './errors.ts'

/** Owner-only directory mode for `$DSH_HOME/phone/screenshots`. */
const SCREENSHOT_DIR_MODE = 0o700
/** Owner-only file mode for each persisted PNG. */
const SCREENSHOT_FILE_MODE = 0o600

/**
 * Persist one validated PNG under `$DSH_HOME/phone/screenshots`.
 * @param deviceId - Branded Android serial or iOS UDID used in the file name.
 * @param png - Complete PNG file bytes already checked by the CLI runner.
 * @returns the absolute PNG path.
 * @throws {@link PhoneDevicesError} with `PHONE_PROTOCOL` when the home path
 *   cannot be created or the PNG cannot be written.
 */
export async function persistPhoneScreenshot(deviceId: string, png: Uint8Array): Promise<string> {
  const dir = dshHomePath('phone', 'screenshots')
  const stamp = `${Date.now().toString(10)}-${randomBytes(4).toString('hex')}`
  const path = join(dir, `${sanitizeScreenshotDeviceId(deviceId)}-${stamp}.png`)
  try {
    await mkdir(dir, { recursive: true, mode: SCREENSHOT_DIR_MODE })
    await writeFile(path, png, { mode: SCREENSHOT_FILE_MODE, flag: 'wx' })
  } catch (error) {
    throw new PhoneDevicesError(
      'PHONE_PROTOCOL',
      `could not persist the PNG screenshot under ${JSON.stringify(dir)}`,
      { cause: error },
    )
  }
  return path
}

/**
 * Keep only filesystem-safe characters from a branded device id so the PNG
 * name cannot leave `phone/screenshots`.
 * @param deviceId - Branded Android serial or iOS UDID.
 * @returns a non-empty file-name fragment.
 */
function sanitizeScreenshotDeviceId(deviceId: string): string {
  const safe = deviceId.replace(/[^A-Za-z0-9._-]+/gu, '_')
  return safe.length > 0 ? safe : 'device'
}
