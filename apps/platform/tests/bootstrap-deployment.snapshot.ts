import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/platform-public-readiness.sh', import.meta.url))
const expected = fileURLToPath(new URL('./snapshots/bootstrap-deployment/entry.expected.md', import.meta.url))

describe('Platform bootstrap deployment entry snapshot', () => {
  it('runs the shipped readiness script against exactly two direct addresses', async () => {
    const harness = [
      'set -eEuo pipefail',
      'exec 2> >(grep -v "\\.bashrc: line 5:" >&2)',
      'instance_ids=(i-first i-second)',
      'BASH_ENV=/dev/null',
      'export BASH_ENV',
      'node() {',
      '  address="${@: -1}"',
      '  origin="${@: -2:1}"',
      '  case "$address" in',
      '    203.0.113.10) relay=relay-1 ;;',
      '    203.0.113.11) relay=relay-2 ;;',
      '    *) exit 22 ;;',
      '  esac',
      '  printf \'probe=%s origin=%s\\n\' "$address" "$origin" >&2',
      '  printf \'{"ok":true,"attachmentStorage":"oss","instanceId":"%s"}\' "$relay"',
      '}',
      'sleep() { :; }',
      'source "$READINESS_SCRIPT"',
      'platform_public_readiness 1 "203.0.113.10,203.0.113.11"',
    ].join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        READINESS_SCRIPT: script,
        PLATFORM_ORIGIN: 'https://www.beikejiedeliulangmao.top',
        PLATFORM_REMOTE_ATTACHMENT_STORAGE: 'oss',
      },
    })
    expect(result.status, result.stderr).toBe(0)
    await compareOrRefresh(expected, [
      '# Platform bootstrap deployment entry',
      '',
      '```text',
      result.stdout.trimEnd(),
      result.stderr.split('\n').filter(line => !line.includes('.bashrc: line 5:')).join('\n').trimEnd(),
      '```',
    ].join('\n'))
  })
})

async function compareOrRefresh(path: string, value: string): Promise<void> {
  const payload = `${value.trimEnd()}\n`
  if (process.env.DSH_SNAPSHOT === 'refresh') {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, payload)
    return
  }
  expect(payload).toBe(await readFile(path, 'utf8'))
}
