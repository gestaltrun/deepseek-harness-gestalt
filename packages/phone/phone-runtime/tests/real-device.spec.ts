import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import PhoneDevices, { deviceId } from '@deepseek-ai/dsh-phone-runtime'

// Exercises the real iPhone link end to end against a real mobilecli install.
// Everything here needs physical hardware and a developer identity, so the
// suite self-skips unless the operator opts in with both environment switches;
// see the package README's Known Limitations.
const REAL_UDID = process.env.DSH_PHONE_REAL_UDID
const PROFILE_PATH = process.env.DSH_PHONE_REAL_PROFILE

describe.skipIf(REAL_UDID === undefined)('phone runtime real iPhone link', () => {
  it('lists the opted-in handset in the reals group and re-signs its agent on demand', { timeout: 300_000 }, async () => {
    const context = new Context()
    try {
      await context.plugin(PhoneDevices, {
        ...(PROFILE_PATH !== undefined ? { provisioningProfilePath: PROFILE_PATH } : {}),
      }).await()
      const list = await context.phoneDevices.listDevices()
      const handset = list.ios.reals.find(device => device.id === deviceId(REAL_UDID as string))
      expect(handset, 'the UDID named by DSH_PHONE_REAL_UDID must appear in the ios.reals group').toBeDefined()
      expect(handset?.online).toBe(true)

      const status = await context.phoneDevices.agentStatus(deviceId(REAL_UDID as string))
      if (!status.installed) {
        const installed = await context.phoneDevices.installAgent(deviceId(REAL_UDID as string))
        expect(installed.installed).toBe(true)
      }
    } finally {
      await context.fiber.dispose()
    }
  })
})
