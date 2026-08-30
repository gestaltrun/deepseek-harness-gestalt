import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stageFake, type StagedFake } from './helpers.ts'

const fakes: StagedFake[] = []

afterEach(async () => {
  await Promise.all(fakes.splice(0).map(fake => fake.dispose()))
})

describe('fake mobilecli launcher', () => {
  it('stages one Windows command shim beside the shared fake module', async () => {
    const fake = await stageFake({}, 'win32')
    fakes.push(fake)
    fake.claim()

    expect(fake.executablePath).toMatch(/fakemobilecli\.cmd$/i)
    const launcher = await readFile(fake.executablePath, 'utf8')
    expect(launcher).toContain(`"${process.execPath.replaceAll('%', '%%')}"`)
    expect(launcher).toContain('%~dp0fakemobilecli.mjs')
    await expect(access(join(dirname(fake.executablePath), 'fakemobilecli.mjs'))).resolves.toBeUndefined()
  })
})
