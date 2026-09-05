import type { Context } from '@deepseek-ai/cordis'
import PhoneDevices from '@deepseek-ai/dsh-phone-runtime'

/** Cordis name for the staged fakemobilecli PhoneDevices mount. */
export const name = 'phone-runtime-staged'

/** Mount the real fleet Service on fakemobilecli with the synthetic Android SDK env. */
export async function apply(ctx: Context): Promise<void> {
  const executablePath = process.env.DSH_PHONE_FAKE_EXECUTABLE
  const portText = process.env.DSH_PHONE_FAKE_PORT
  const sdkRoot = process.env.ANDROID_SDK_ROOT
  if (executablePath === undefined || executablePath.length === 0) {
    throw new Error('phone-runtime-staged requires DSH_PHONE_FAKE_EXECUTABLE')
  }
  const serverPort = Number(portText)
  if (!Number.isSafeInteger(serverPort) || serverPort < 1) {
    throw new Error('phone-runtime-staged requires DSH_PHONE_FAKE_PORT')
  }
  if (sdkRoot === undefined || sdkRoot.length === 0) {
    throw new Error('phone-runtime-staged requires ANDROID_SDK_ROOT')
  }
  const fiber = ctx.plugin(PhoneDevices, {
    deferStart: true,
    serverPort,
    pollIntervalMs: 20,
    readyTimeoutMs: 6_000,
    requestTimeoutMs: 1_500,
    bootTimeoutMs: 2_000,
    h264ProbeTimeoutMs: 5_000,
  })
  await fiber.await()
  await fiber.ctx.phoneDevices.activateExecutable(executablePath, undefined, {
    ANDROID_SDK_ROOT: sdkRoot,
    PATH: process.env.PATH ?? '',
  })
}
