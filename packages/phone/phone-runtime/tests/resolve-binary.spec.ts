import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mobilecliInstallGuidance, resolveMobilecliExecutable } from '../src/resolve-binary.ts'

const roots: string[] = []
const electronMinimalPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function stageDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-phone-resolve-'))
  roots.push(root)
  return root
}

async function writeExecutable(dir: string, name: string, content = '#!/bin/sh\nexit 0\n'): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content)
  await chmod(path, 0o755)
  return path
}

describe('explicit executablePath', () => {
  it('accepts an absolute executable file', async () => {
    const dir = await stageDir()
    const exe = await writeExecutable(dir, 'mobilecli')
    expect(resolveMobilecliExecutable({ executablePath: exe, env: {} })).toBe(exe)
  })

  it('resolves a relative override against the cwd', async () => {
    const dir = await stageDir()
    const exe = await writeExecutable(dir, 'mobilecli')
    const workdir = process.cwd()
    process.chdir(dir)
    try {
      const found = resolveMobilecliExecutable({ executablePath: './mobilecli', env: {} })
      // macOS /var is a symlink to /private/var; compare real paths.
      expect(realpathSync(found)).toBe(realpathSync(exe))
    } finally {
      process.chdir(workdir)
    }
  })

  it('rejects a configured path that is not an executable file with an actionable message', async () => {
    const dir = await stageDir()
    const missing = join(dir, 'nowhere', 'mobilecli')
    expect(() => resolveMobilecliExecutable({ executablePath: missing, env: {} }))
      .toThrow(/executablePath.*not an executable file[\s\S]*npm install -g mobilecli@latest/s)
  })
})

describe('PATH discovery', () => {
  it('returns the first matching directory entry', async () => {
    const first = await stageDir()
    const second = await stageDir()
    const wanted = await writeExecutable(second, 'mobilecli')
    await writeExecutable(first, 'unrelated')
    const found = resolveMobilecliExecutable({ env: { PATH: [first, second].join(delimiter) } })
    expect(found).toBe(wanted)
  })

  it('deduplicates repeated PATH directories without changing search order', async () => {
    const empty = await stageDir()
    const real = await stageDir()
    const wanted = await writeExecutable(real, 'mobilecli')
    const found = resolveMobilecliExecutable({ env: { PATH: [empty, empty, real].join(delimiter) }, home: '' })
    expect(found).toBe(wanted)
  })

  it('skips non-executable and directory collisions under POSIX semantics', async () => {
    const dir = await stageDir()
    await writeFile(join(dir, 'mobilecli'), 'plain data')
    const real = await stageDir()
    const wanted = await writeExecutable(real, 'mobilecli')
    expect(resolveMobilecliExecutable({
      env: { PATH: [dir, real].join(delimiter) },
      isWindows: false,
    })).toBe(wanted)
  })

  it('skips a directory that shares the candidate name', async () => {
    const dir = await stageDir()
    await mkdir(join(dir, 'mobilecli'), { recursive: true })
    const real = await stageDir()
    const wanted = await writeExecutable(real, 'mobilecli')
    expect(resolveMobilecliExecutable({ env: { PATH: [dir, real].join(delimiter) } })).toBe(wanted)
  })

  it('throws guidance naming every searched directory when nothing matches', async () => {
    const dir = await stageDir()
    const guidance = (() => {
      try {
        resolveMobilecliExecutable({ env: { PATH: dir } })
        return undefined
      } catch (error) {
        return (error as Error).message
      }
    })()
    expect(guidance).toContain(mobilecliInstallGuidance([dir]).slice(0, 40))
    expect(guidance).toContain('npm install -g mobilecli@latest')
    expect(guidance).toContain(`  ${dir}`)
    expect(guidance).toContain('executablePath')
  })

  it('treats an empty search space as a failing search', () => {
    expect(() => resolveMobilecliExecutable({ env: {} })).toThrow(/\(no candidate directories\)/)
  })

  it('finds mobilecli in the npx cache when PATH misses', async () => {
    const dir = await stageDir()
    await writeExecutable(dir, 'mobilecli')
    const home = await stageDir()
    const npxBin = join(home, '.npm', '_npx', 'abc123', 'node_modules', '.bin')
    await mkdir(npxBin, { recursive: true })
    await copyFile(join(dir, 'mobilecli'), join(npxBin, 'mobilecli'))
    const resolved = resolveMobilecliExecutable({ env: { PATH: '/no/mobilecli/here' }, home })
    expect(resolved).toBe(join(npxBin, 'mobilecli'))
  })

  it('prefers PATH over the npx cache and the npm-global directory', async () => {
    const dir = await stageDir()
    await writeExecutable(dir, 'mobilecli')
    const home = await stageDir()
    const npxBin = join(home, '.npm', '_npx', 'abc123', 'node_modules', '.bin')
    const globalBin = join(home, '.npm-global', 'bin')
    await mkdir(npxBin, { recursive: true })
    await mkdir(globalBin, { recursive: true })
    await copyFile(join(dir, 'mobilecli'), join(npxBin, 'mobilecli'))
    await copyFile(join(dir, 'mobilecli'), join(globalBin, 'mobilecli'))
    const pathDir = await stageDir()
    await copyFile(join(dir, 'mobilecli'), join(pathDir, 'mobilecli'))
    const resolved = resolveMobilecliExecutable({
      env: { PATH: pathDir },
      home,
    })
    expect(resolved).toBe(join(pathDir, 'mobilecli'))
  })

  it('finds mobilecli in the npm-global directory when PATH misses', async () => {
    const dir = await stageDir()
    await writeExecutable(dir, 'mobilecli')
    const home = await stageDir()
    const globalBin = join(home, '.npm-global', 'bin')
    await mkdir(globalBin, { recursive: true })
    await copyFile(join(dir, 'mobilecli'), join(globalBin, 'mobilecli'))
    const resolved = resolveMobilecliExecutable({ env: { PATH: '/no/mobilecli/here' }, home })
    expect(resolved).toBe(join(globalBin, 'mobilecli'))
  })

  it('finds mobilecli via npm_config_prefix when PATH and HOME miss', async () => {
    const dir = await stageDir()
    const prefixBin = join(dir, 'bin')
    await mkdir(prefixBin, { recursive: true })
    await writeExecutable(prefixBin, 'mobilecli')
    const resolved = resolveMobilecliExecutable({
      env: { PATH: '/no/mobilecli/here', npm_config_prefix: dir },
      home: '',
      isWindows: false,
    })
    expect(resolved).toBe(join(prefixBin, 'mobilecli'))
  })

  it('prefers npm-global over the npx cache when PATH misses', async () => {
    const dir = await stageDir()
    await writeExecutable(dir, 'mobilecli')
    const home = await stageDir()
    const npxBin = join(home, '.npm', '_npx', 'abc123', 'node_modules', '.bin')
    const globalBin = join(home, '.npm-global', 'bin')
    await mkdir(npxBin, { recursive: true })
    await mkdir(globalBin, { recursive: true })
    await copyFile(join(dir, 'mobilecli'), join(npxBin, 'mobilecli'))
    await copyFile(join(dir, 'mobilecli'), join(globalBin, 'mobilecli'))
    const resolved = resolveMobilecliExecutable({ env: { PATH: '/no/mobilecli/here' }, home })
    expect(resolved).toBe(join(globalBin, 'mobilecli'))
  })

  it('still searches npm locations under an Electron-minimal PATH', async () => {
    const dir = await stageDir()
    await writeExecutable(dir, 'mobilecli')
    const home = await stageDir()
    const globalBin = join(home, '.npm-global', 'bin')
    await mkdir(globalBin, { recursive: true })
    await copyFile(join(dir, 'mobilecli'), join(globalBin, 'mobilecli'))
    const resolved = resolveMobilecliExecutable({
      env: { PATH: electronMinimalPath },
      home,
      isWindows: false,
    })
    expect(resolved).toBe(join(globalBin, 'mobilecli'))
  })

  it('adds Homebrew and /usr/local prefixes only for an Electron-minimal PATH', async () => {
    const empty = (() => {
      try {
        resolveMobilecliExecutable({ env: {}, home: '', isWindows: false })
        return undefined
      } catch (error) {
        return (error as Error).message
      }
    })()
    expect(empty).toContain('(no candidate directories)')
    expect(empty).not.toContain('/opt/homebrew/bin')
    const electron = (() => {
      try {
        return { resolved: resolveMobilecliExecutable({
          env: { PATH: electronMinimalPath },
          home: '',
          isWindows: false,
        }) }
      } catch (error) {
        return { guidance: (error as Error).message }
      }
    })()
    if ('resolved' in electron) {
      expect(['/opt/homebrew/bin/mobilecli', '/usr/local/bin/mobilecli']).toContain(electron.resolved)
    } else {
      expect(electron.guidance).toContain('  /opt/homebrew/bin')
      expect(electron.guidance).toContain('  /usr/local/bin')
      expect(electron.guidance).toContain('npm install -g mobilecli@latest')
    }
  })
})

describe('Windows candidate probing', () => {
  it('honors PATHEXT order and accepts extensionless candidates last', async () => {
    const dir = await stageDir()
    const cmdShim = await writeExecutable(dir, 'mobilecli.cmd')
    await writeExecutable(dir, 'mobilecli')
    const found = resolveMobilecliExecutable({
      env: { PATH: dir, PATHEXT: '.CMD;.EXE;.BAT' },
      isWindows: true,
    })
    expect(found.toLowerCase()).toBe(cmdShim.toLowerCase())
    expect(found.toLowerCase().endsWith('.cmd')).toBe(true)
  })

  it('rejects a Windows-configured extensionless file without execution probing divergence', async () => {
    const dir = await stageDir()
    const exe = await writeExecutable(dir, 'mobilecli.exe')
    expect(resolveMobilecliExecutable({ env: { PATH: dir }, isWindows: true })).toBe(exe)
  })

  it('takes the explicit override before scanning on Windows semantics too', async () => {
    const dir = await stageDir()
    const exe = await writeExecutable(dir, 'customcli.cmd')
    expect(resolveMobilecliExecutable({ executablePath: exe, env: { PATH: dir }, isWindows: true })).toBe(exe)
  })

  it('searches the Windows roaming npm directory under the supplied home', async () => {
    const home = await stageDir()
    const roamingBin = join(home, 'AppData', 'Roaming', 'npm')
    await mkdir(roamingBin, { recursive: true })
    const wanted = await writeExecutable(roamingBin, 'mobilecli.cmd')
    expect(resolveMobilecliExecutable({ env: { PATH: '/missing' }, home, isWindows: true })).toBe(wanted)
  })

  it('uses npm_config_prefix itself as the Windows npm bin directory', async () => {
    const prefix = await stageDir()
    const wanted = await writeExecutable(prefix, 'mobilecli.exe')
    expect(resolveMobilecliExecutable({
      env: { PATH: '/missing', npm_config_prefix: prefix },
      home: '',
      isWindows: true,
    })).toBe(wanted)
  })
})
