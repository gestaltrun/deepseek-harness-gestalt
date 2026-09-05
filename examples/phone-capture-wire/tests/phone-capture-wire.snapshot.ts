import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { buildGradientH264 } from '../../../packages/phone/phone-runtime/tests/fixtures/u3-visible-frames.ts'
import { stageFake, wireDevice } from '../../../packages/phone/phone-runtime/tests/helpers.ts'

const srcBin = fileURLToPath(new URL('../../../packages/examples/phone-capture-wire-demo/src/bin.ts', import.meta.url))
const libBin = fileURLToPath(new URL('../../../packages/examples/phone-capture-wire-demo/lib/bin.js', import.meta.url))
const config = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const adbSource = fileURLToPath(new URL('./fixtures/synthetic-adb.mjs', import.meta.url))
const expected = fileURLToPath(new URL('./snapshots/android-capture-logical-io/transcript.expected.json', import.meta.url))

describe('Android capture-source Host wire assembled snapshot', () => {
  it('rejects a mismatched plane with no upstream io and maps a compatible downsample', async () => {
    const sdk = await mkdtemp(join(tmpdir(), 'dsh-phone-capture-wire-sdk-'))
    const fake = await stageFake({
      devices: [wireDevice('emulator-5554', 'android', 'emulator', 'online')],
      streamFrameCount: 20,
    })
    try {
      const tools = join(sdk, 'platform-tools')
      await mkdir(tools)
      await copyFile(adbSource, join(tools, 'adb'))
      await chmod(join(tools, 'adb'), 0o755)
      await writeFile(join(tools, 'native.h264'), buildGradientH264(1))
      await fake.claim()
      const result = await runLoaderSmoke({
        label: 'phone-capture-wire-keyless',
        tempDirPrefix: 'phone-capture-wire-keyless-',
        binScript: srcBin,
        libBinScript: libBin,
        configPath: config,
        tsconfigPath: tsconfig,
        env: {
          PATH: `${tools}${delimiter}${process.env.PATH ?? ''}`,
          ANDROID_SDK_ROOT: sdk,
          DSH_PHONE_FAKE_EXECUTABLE: fake.executablePath,
          DSH_PHONE_FAKE_PORT: String(fake.port),
          DSH_PHONE_FAKE_BASE_URL: fake.baseUrl,
        },
      })
      expect(result.stderr).toBe('')
      await expect(`${JSON.stringify(JSON.parse(result.stdout) as unknown, null, 2)}\n`).toMatchFileSnapshot(expected)
    } finally {
      try {
        await fake.dispose()
      } finally {
        await rm(sdk, { recursive: true, force: true })
      }
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
