/** Runnable keyless snapshot for the selected cross-runtime Noise security path. */

import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const runner = join(root, 'scripts/noise-security-path/run-node.mjs')
const expected = join(root, 'scripts/snapshots/noise-security-path/report.expected.json')
const refreshing = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'

describe('Noise security path runnable snapshot', () => {
  it('packages the exact product Noise implementation for native WebViews', async () => {
    for (const file of ['dsh_noise_channel.js', 'dsh_noise_channel_bg.wasm']) {
      const product = await readFile(join(root, 'packages/platform/noise-channel/pkg', file))
      const nativeProof = await readFile(join(root, 'scripts/noise-security-path/pkg', file))
      expect(nativeProof).toEqual(product)
    }
  })

  it('runs the selected engine through official vectors and bounded attack cases', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [runner, 'snapshot'], {
      cwd: root,
      maxBuffer: 4 * 1024 * 1024,
    })
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toMatchObject({
      runtime: 'snapshot',
      allPass: true,
      targetFlows: { pairingXkpsk3: 'pass', reconnectIk: 'pass' },
    })
    if (refreshing) {
      await mkdir(dirname(expected), { recursive: true })
      await writeFile(expected, stdout)
    } else {
      await access(expected)
    }
    await expect(stdout).toMatchFileSnapshot(expected)
  })
})
