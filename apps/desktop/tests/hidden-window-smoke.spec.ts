import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { PassThrough, Readable } from 'node:stream'
import {
  createHiddenWindowSmokeOwner,
  hiddenWindowSmokeEnvironment,
  type HiddenWindowSmokeDeadline,
} from './helpers/hidden-window-smoke-owner.ts'
import {
  HIDDEN_WINDOW_SMOKE_BUNDLE,
  HIDDEN_WINDOW_SMOKE_ENTRY,
  HIDDEN_WINDOW_SMOKE_SOURCE,
  requireHiddenWindowSmokeEntry,
  spawnHiddenWindowSmoke,
} from './helpers/hidden-window-smoke-launch.ts'
import {
  parseHiddenWindowSmokeResult,
  parseHiddenWindowSmokeResultFile,
} from './helpers/hidden-window-smoke-result.ts'
import {
  assertHiddenWindowSmokeAcceptance,
  runHiddenWindowSmoke,
} from './helpers/hidden-window-smoke-run.ts'
import { desktopWindowConstructorOptions, handleDesktopWindowActivate } from '../src/e2e-profile.ts'

const ACCEPTED_RESULT = {
  visible: false,
  shownOnCreate: false,
  activate: 'handled',
  captureEmpty: false,
  captureWidth: 320,
  captureHeight: 240,
} as const

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hidden-window-smoke-'))
  roots.push(root)
  return root
}

function settledDeadline(): HiddenWindowSmokeDeadline {
  return {
    async settle<T>(_lane: 'result' | 'exit' | 'stdio', operation: Promise<T>) {
      const value: T = await operation
      return { status: 'settled' as const, value }
    },
  }
}

function attachStdio(child: EventEmitter & ChildProcess, text = { stdout: '', stderr: '' }): void {
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  child.stdout = stdout
  child.stderr = stderr
  queueMicrotask(() => {
    if (text.stdout.length > 0) stdout.push(Buffer.from(text.stdout))
    stdout.push(null)
    if (text.stderr.length > 0) stderr.push(Buffer.from(text.stderr))
    stderr.push(null)
  })
}

function exitingChild(code: number | null, signal: NodeJS.Signals | null): EventEmitter & ChildProcess {
  const child = new EventEmitter() as EventEmitter & ChildProcess
  attachStdio(child)
  queueMicrotask(() => {
    child.emit('exit', code, signal)
    child.emit('close', code, signal)
  })
  return child
}

describe('hidden-window smoke ownership', () => {
  it('returns an allocated settled Promise after spawn and retains userData after a direct-child exit 0', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    writeFileSync(join(userData, 'state'), 'retain')
    const child = exitingChild(0, null)
    let spawned = false
    const owner = createHiddenWindowSmokeOwner(
      () => {
        spawned = true
        return child
      },
      async () => ACCEPTED_RESULT,
      settledDeadline(),
      userData,
    )
    expect(spawned).toBe(true)
    expect(owner.child).toBe(child)
    const report = await owner.settled
    expect(report.cleanup.process).toBe('direct-child-exited')
    expect(report.cleanup.tree).toBe('unverified')
    expect(report.cleanup.userDataRemoved).toBe(false)
    expect(report.exitCode).toBe(0)
    expect(report.acceptance).toEqual({ status: 'accepted', captureWidth: 320, captureHeight: 240 })
    expect(existsSync(join(userData, 'state'))).toBe(true)
  })

  it('retains userData when the direct child exits nonzero', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    writeFileSync(join(userData, 'state'), 'retain')
    const owner = createHiddenWindowSmokeOwner(
      () => exitingChild(1, null),
      async () => ({ visible: false }),
      settledDeadline(),
      userData,
    )
    const report = await owner.settled
    expect(report.cleanup.process).toBe('unverified')
    expect(report.cleanup.tree).toBe('unverified')
    expect(report.cleanup.userDataRemoved).toBe(false)
    expect(existsSync(join(userData, 'state'))).toBe(true)
  })

  it('retains userData when result settlement expires even if the child exits 0', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    writeFileSync(join(userData, 'state'), 'retain')
    const deadline: HiddenWindowSmokeDeadline = {
      async settle(lane, operation) {
        if (lane === 'result') return { status: 'expired' }
        return { status: 'settled', value: await operation }
      },
    }
    const owner = createHiddenWindowSmokeOwner(
      () => exitingChild(0, null),
      async () => new Promise(() => {}),
      deadline,
      userData,
    )
    const report = await owner.settled
    expect(report.cleanup.process).toBe('unverified')
    expect(report.cleanup.tree).toBe('unverified')
    expect(existsSync(join(userData, 'state'))).toBe(true)
  })

  it('retains userData after forced SIGTERM of the exact ChildProcess', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    writeFileSync(join(userData, 'state'), 'retain')
    const hanging = new EventEmitter() as EventEmitter & ChildProcess
    attachStdio(hanging)
    hanging.kill = (signal?: NodeJS.Signals) => {
      hanging.emit('exit', null, signal ?? 'SIGTERM')
      hanging.emit('close', null, signal ?? 'SIGTERM')
      return true
    }
    let exitAttempts = 0
    const deadline: HiddenWindowSmokeDeadline = {
      async settle(lane, operation) {
        if (lane === 'result') return { status: 'expired' }
        if (lane === 'exit') {
          exitAttempts += 1
          if (exitAttempts === 1) return { status: 'expired' }
        }
        return { status: 'settled', value: await operation }
      },
    }
    const owner = createHiddenWindowSmokeOwner(
      () => hanging,
      async () => new Promise(() => {}),
      deadline,
      userData,
    )
    const report = await owner.settled
    expect(report.cleanup.process).toBe('forced')
    expect(report.cleanup.tree).toBe('unverified')
    expect(report.cleanup.userDataRemoved).toBe(false)
    expect(existsSync(join(userData, 'state'))).toBe(true)
  })

  it('does not treat ChildProcess.killed as termination when exitCode and signalCode stay null', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    writeFileSync(join(userData, 'state'), 'retain')
    const hanging = new EventEmitter() as EventEmitter & ChildProcess
    hanging.stdout = null
    hanging.stderr = null
    Object.defineProperty(hanging, 'killed', { configurable: true, get: () => killed })
    Object.defineProperty(hanging, 'exitCode', { configurable: true, get: () => null })
    Object.defineProperty(hanging, 'signalCode', { configurable: true, get: () => null })
    let killed = false
    const kills: string[] = []
    hanging.kill = (signal?: NodeJS.Signals) => {
      kills.push(signal ?? 'SIGTERM')
      killed = true
      return true
    }
    const deadline: HiddenWindowSmokeDeadline = {
      async settle() {
        return { status: 'expired' }
      },
    }
    const report = await createHiddenWindowSmokeOwner(
      () => hanging,
      async () => new Promise(() => {}),
      deadline,
      userData,
    ).settled
    hanging.removeAllListeners()
    expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(report.cleanup.process).toBe('unverified')
    expect(report.cleanup.tree).toBe('unverified')
    expect(report.cleanup.userDataRemoved).toBe(false)
    expect(existsSync(join(userData, 'state'))).toBe(true)
  })

  it('joins after SIGKILL then still reports unverified and retains userData', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    writeFileSync(join(userData, 'state'), 'retain')
    const hanging = new EventEmitter() as EventEmitter & ChildProcess
    attachStdio(hanging)
    const kills: string[] = []
    hanging.kill = (signal?: NodeJS.Signals) => {
      kills.push(signal ?? 'SIGTERM')
      if (signal === 'SIGKILL') {
        hanging.emit('exit', null, 'SIGKILL')
        hanging.emit('close', null, 'SIGKILL')
      }
      return true
    }
    let exitAttempts = 0
    const deadline: HiddenWindowSmokeDeadline = {
      async settle(lane, operation) {
        if (lane === 'stdio') return { status: 'settled', value: await operation }
        if (lane === 'result') return { status: 'expired' }
        exitAttempts += 1
        if (exitAttempts <= 2) return { status: 'expired' }
        return { status: 'settled', value: await operation }
      },
    }
    const owner = createHiddenWindowSmokeOwner(
      () => hanging,
      async () => new Promise(() => {}),
      deadline,
      userData,
    )
    const report = await owner.settled
    expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(report.cleanup.process).toBe('unverified')
    expect(report.cleanup.tree).toBe('unverified')
    expect(report.cleanup.userDataRemoved).toBe(false)
    expect(existsSync(join(userData, 'state'))).toBe(true)
  })

  it('replaces module-owned exit observers with a detached late-error observer after deadline expiry', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    const child = new EventEmitter() as EventEmitter & ChildProcess
    child.stdout = null
    child.stderr = null
    child.kill = () => true
    const deadline: HiddenWindowSmokeDeadline = {
      async settle() {
        return { status: 'expired' }
      },
    }
    const owner = createHiddenWindowSmokeOwner(
      () => child,
      async () => new Promise(() => {}),
      deadline,
      userData,
    )
    const report = await owner.settled
    expect(report.cleanup.process).toBe('unverified')
    expect(Object.isFrozen(report)).toBe(true)
    expect(child.listenerCount('exit')).toBe(1)
    expect(child.listenerCount('close')).toBe(1)
    expect(child.listenerCount('error')).toBe(1)
    child.emit('error', new Error('late-unhandled'))
    expect(report.diagnostics.some(item => item.message.includes('late-unhandled'))).toBe(false)
    expect(owner.lateDiagnostics.filter(item => item.message.includes('late-unhandled'))).toHaveLength(1)
    child.emit('error', new Error('late-unhandled-again'))
    for (let index = 0; index < 16; index += 1) child.emit('error', new Error(`late-flood-${index}`))
    expect(owner.lateDiagnostics.length).toBeLessThanOrEqual(8)
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  })

  it('does not SIGTERM a child that already has signalCode when the first exit settle expires', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    const child = new EventEmitter() as EventEmitter & ChildProcess
    child.stdout = null
    child.stderr = null
    Object.defineProperty(child, 'exitCode', { configurable: true, get: () => null })
    Object.defineProperty(child, 'signalCode', { configurable: true, get: () => 'SIGTERM' })
    const kills: string[] = []
    child.kill = (signal?: NodeJS.Signals) => {
      kills.push(signal ?? 'SIGTERM')
      return true
    }
    let exitAttempts = 0
    const deadline: HiddenWindowSmokeDeadline = {
      async settle(lane, operation) {
        if (lane === 'exit') {
          exitAttempts += 1
          if (exitAttempts === 1) return { status: 'expired' }
        }
        return { status: 'settled', value: await operation }
      },
    }
    const report = await createHiddenWindowSmokeOwner(
      () => child,
      async () => ({ visible: false }),
      deadline,
      userData,
    ).settled
    expect(kills).toEqual([])
    expect(report.signal).toBe('SIGTERM')
    expect(report.cleanup.process).toBe('unverified')
    expect(report.cleanup.tree).toBe('unverified')
    expect(existsSync(userData)).toBe(true)
  })

  it('does not SIGTERM a child that already emitted exit during readResult when the first exit settle expires', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    const child = new EventEmitter() as EventEmitter & ChildProcess
    child.stdout = null
    child.stderr = null
    const kills: string[] = []
    child.kill = (signal?: NodeJS.Signals) => {
      kills.push(signal ?? 'SIGTERM')
      return true
    }
    let exitAttempts = 0
    const deadline: HiddenWindowSmokeDeadline = {
      async settle(lane, operation) {
        if (lane === 'exit') {
          exitAttempts += 1
          if (exitAttempts === 1) return { status: 'expired' }
        }
        return { status: 'settled', value: await operation }
      },
    }
    const report = await createHiddenWindowSmokeOwner(
      () => child,
      () => {
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
        return Promise.resolve({ visible: false })
      },
      deadline,
      userData,
    ).settled
    expect(kills).toEqual([])
    expect(report.exitCode).toBe(0)
    expect(report.cleanup.process).toBe('direct-child-exited')
    expect(report.cleanup.tree).toBe('unverified')
    expect(existsSync(userData)).toBe(true)
  })

  it('retains a PassThrough stdout error as unverified rather than EOF', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    const child = new EventEmitter() as EventEmitter & ChildProcess
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    child.stdout = stdout
    child.stderr = stderr
    const kills: string[] = []
    child.kill = (signal?: NodeJS.Signals) => {
      kills.push(signal ?? 'SIGTERM')
      return true
    }
    const report = await createHiddenWindowSmokeOwner(
      () => child,
      () => {
        stdout.emit('error', new Error('stdio-probe-failure'))
        stderr.end()
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
        return Promise.resolve({ visible: false })
      },
      settledDeadline(),
      userData,
    ).settled
    stdout.destroy()
    stderr.destroy()
    expect(kills).toEqual([])
    expect(report.diagnostics.some(item => item.source === 'stdout' && item.message.includes('stdio-probe-failure'))).toBe(true)
    expect(report.cleanup.process).toBe('unverified')
    expect(existsSync(userData)).toBe(true)
  })

  it('preserves a stdout stream error instead of treating drain as success', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    const child = new EventEmitter() as EventEmitter & ChildProcess
    const stdout = new Readable({ read() {} })
    const stderr = new Readable({ read() {} })
    child.stdout = stdout
    child.stderr = stderr
    queueMicrotask(() => {
      stdout.emit('error', new Error('stdout broke'))
      stderr.push(null)
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
    })
    const report = await createHiddenWindowSmokeOwner(
      () => child,
      async () => ({ visible: false }),
      settledDeadline(),
      userData,
    ).settled
    expect(report.diagnostics.some(item => item.source === 'stdout' && item.message.includes('stdout broke'))).toBe(true)
    expect(report.cleanup.process).toBe('unverified')
    expect(existsSync(userData)).toBe(true)
  })

  it('stops the exact child when the exit deadline throws', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    writeFileSync(join(userData, 'state'), 'retain')
    const hanging = new EventEmitter() as EventEmitter & ChildProcess
    attachStdio(hanging)
    const kills: string[] = []
    hanging.kill = (signal?: NodeJS.Signals) => {
      kills.push(signal ?? 'SIGTERM')
      hanging.emit('exit', null, signal ?? 'SIGTERM')
      hanging.emit('close', null, signal ?? 'SIGTERM')
      return true
    }
    let exitAttempts = 0
    const deadline: HiddenWindowSmokeDeadline = {
      async settle(lane, operation) {
        if (lane === 'exit') {
          exitAttempts += 1
          if (exitAttempts === 1) throw new Error('exit deadline exploded')
        }
        return { status: 'settled', value: await operation }
      },
    }
    const report = await createHiddenWindowSmokeOwner(
      () => hanging,
      async () => ({ visible: false }),
      deadline,
      userData,
    ).settled
    expect(kills[0]).toBe('SIGTERM')
    expect(report.cleanup.process).toBe('forced')
    expect(existsSync(join(userData, 'state'))).toBe(true)
  })

  it('observes the original result promise before a result deadline that throws without touching it', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    let rejectResult!: (error: Error) => void
    const result = new Promise<unknown>((_resolve, reject) => { rejectResult = reject })
    let attachments = 0
    const originalThen = result.then.bind(result)
    result.then = ((onFulfilled?: ((value: unknown) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) => {
      attachments += 1
      return originalThen(onFulfilled, onRejected)
    }) as typeof result.then
    const deadline: HiddenWindowSmokeDeadline = {
      async settle(lane, operation) {
        if (lane === 'result') throw new Error('result deadline exploded')
        return { status: 'settled', value: await operation }
      },
    }
    const owner = createHiddenWindowSmokeOwner(
      () => exitingChild(0, null),
      () => result,
      deadline,
      userData,
    )
    const report = await owner.settled
    expect(attachments).toBeGreaterThan(0)
    expect(report.diagnostics.some(item => item.message.includes('result deadline exploded'))).toBe(true)
    expect(owner.lateDiagnostics).toEqual([])
    rejectResult(new Error('late result failed'))
    await result.catch(() => undefined)
    expect(report.diagnostics.some(item => item.message.includes('late result failed'))).toBe(false)
    expect(owner.lateDiagnostics.filter(item => item.source === 'result' && item.message === 'late result rejected: Error: late result failed')).toHaveLength(1)
  })

  it('keeps a prompt result rejection primary when the result deadline throws', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    const result = Promise.reject(new Error('prompt-reject'))
    void result.then(() => undefined, () => undefined)
    const deadline: HiddenWindowSmokeDeadline = {
      async settle(lane, operation) {
        if (lane === 'result') throw new Error('result deadline exploded')
        return { status: 'settled', value: await operation }
      },
    }
    const owner = createHiddenWindowSmokeOwner(
      () => exitingChild(0, null),
      () => result,
      deadline,
      userData,
    )
    const report = await owner.settled
    expect(report.diagnostics.some(item => item.message.includes('prompt-reject'))).toBe(true)
    expect(owner.lateDiagnostics.filter(item => item.message.includes('prompt-reject'))).toHaveLength(0)
  })

  it('records a late result rejection after a result-deadline throw without mutating the frozen report', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    let rejectResult!: (error: Error) => void
    const result = new Promise<unknown>((_resolve, reject) => { rejectResult = reject })
    const deadline: HiddenWindowSmokeDeadline = {
      async settle(lane, operation) {
        if (lane === 'result') throw new Error('result deadline exploded')
        return { status: 'settled', value: await operation }
      },
    }
    const owner = createHiddenWindowSmokeOwner(
      () => exitingChild(0, null),
      () => result,
      deadline,
      userData,
    )
    const report = await owner.settled
    expect(Object.isFrozen(report)).toBe(true)
    expect(report.diagnostics.some(item => item.message.includes('result deadline exploded'))).toBe(true)
    expect(owner.lateDiagnostics).toEqual([])
    rejectResult(new Error('late-result-reject-after-throw'))
    await result.catch(() => undefined)
    expect(report.diagnostics.some(item => item.message.includes('late-result-reject-after-throw'))).toBe(false)
    expect(owner.lateDiagnostics.filter(item => item.source === 'result' && item.message === 'late result rejected: Error: [redacted]')).toHaveLength(1)
  })

  it('records a late result rejection after expiry without mutating the frozen report', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    let rejectResult!: (error: Error) => void
    const result = new Promise<unknown>((_resolve, reject) => { rejectResult = reject })
    const deadline: HiddenWindowSmokeDeadline = {
      async settle(lane, operation) {
        if (lane === 'result') return { status: 'expired' }
        return { status: 'settled', value: await operation }
      },
    }
    const owner = createHiddenWindowSmokeOwner(
      () => exitingChild(0, null),
      () => result,
      deadline,
      userData,
    )
    const report = await owner.settled
    expect(Object.isFrozen(report)).toBe(true)
    expect(report.acceptance.status).toBe('missing')
    expect(report.diagnostics.some(item => item.message === 'result settlement expired')).toBe(true)
    expect(owner.lateDiagnostics).toEqual([])
    rejectResult(new Error('late result failed'))
    await result.catch(() => undefined)
    expect(report.diagnostics.some(item => item.message.includes('late result failed'))).toBe(false)
    expect(owner.lateDiagnostics.filter(item => item.source === 'result' && item.message === 'late result rejected: Error: late result failed')).toHaveLength(1)
  })

  it('does not treat a running-child error as exit and still bounded-joins', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    writeFileSync(join(userData, 'state'), 'retain')
    const hanging = new EventEmitter() as EventEmitter & ChildProcess
    hanging.stdout = null
    hanging.stderr = null
    const kills: string[] = []
    hanging.kill = (signal?: NodeJS.Signals) => {
      kills.push(signal ?? 'SIGTERM')
      if (signal === 'SIGKILL') {
        hanging.emit('exit', null, 'SIGKILL')
        hanging.emit('close', null, 'SIGKILL')
      }
      return true
    }
    let exitAttempts = 0
    const deadline: HiddenWindowSmokeDeadline = {
      async settle(lane, operation) {
        if (lane === 'stdio') return { status: 'settled', value: await operation }
        if (lane === 'result') return { status: 'expired' }
        exitAttempts += 1
        if (exitAttempts <= 2) return { status: 'expired' }
        return { status: 'settled', value: await operation }
      },
    }
    const report = await createHiddenWindowSmokeOwner(
      () => hanging,
      () => {
        hanging.emit('error', new Error('running-child-error'))
        return Promise.resolve(ACCEPTED_RESULT)
      },
      deadline,
      userData,
    ).settled
    expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(report.cleanup.process).toBe('unverified')
    expect(report.cleanup.tree).toBe('unverified')
    expect(report.diagnostics.some(item => item.message.includes('running-child-error'))).toBe(true)
    expect(existsSync(join(userData, 'state'))).toBe(true)
  })

  it('reports unverified spawn failure without a child', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    const owner = createHiddenWindowSmokeOwner(
      () => { throw new Error('spawn failed') },
      async () => ({ visible: false }),
      settledDeadline(),
      userData,
    )
    expect(owner.child).toBeUndefined()
    const report = await owner.settled
    expect(report.cleanup.process).toBe('unverified')
    expect(report.cleanup.tree).toBe('unverified')
    expect(existsSync(userData)).toBe(true)
  })

  it('reports unverified when kill throws and retains userData', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    writeFileSync(join(userData, 'state'), 'retain')
    const hanging = new EventEmitter() as EventEmitter & ChildProcess
    attachStdio(hanging)
    hanging.once = ((_event: string, _listener: (...args: unknown[]) => void) => hanging) as ChildProcess['once']
    hanging.kill = () => { throw new Error('kill refused') }
    const deadline: HiddenWindowSmokeDeadline = {
      async settle(lane, operation) {
        if (lane === 'stdio') return { status: 'settled', value: await operation }
        return { status: 'expired' }
      },
    }
    const owner = createHiddenWindowSmokeOwner(
      () => hanging,
      async () => new Promise(() => {}),
      deadline,
      userData,
    )
    const report = await owner.settled
    expect(report.cleanup.process).toBe('unverified')
    expect(report.cleanup.tree).toBe('unverified')
    expect(existsSync(join(userData, 'state'))).toBe(true)
  })

  it('never deletes userData on exit 0, nonzero, signal, result timeout, or stdio timeout', async () => {
    const deadlineFor = (expired: 'result' | 'stdio' | undefined): HiddenWindowSmokeDeadline => ({
      async settle(lane, operation) {
        if (lane === expired) return { status: 'expired' }
        return { status: 'settled', value: await operation }
      },
    })
    const cases: Array<{
      child: () => EventEmitter & ChildProcess
      deadline: HiddenWindowSmokeDeadline
      result: () => Promise<unknown>
    }> = [
      { child: () => exitingChild(0, null), deadline: settledDeadline(), result: async () => ({ visible: false }) },
      { child: () => exitingChild(1, null), deadline: settledDeadline(), result: async () => ({ visible: false }) },
      { child: () => exitingChild(null, 'SIGTERM'), deadline: settledDeadline(), result: async () => ({ visible: false }) },
      { child: () => exitingChild(0, null), deadline: deadlineFor('result'), result: async () => new Promise(() => {}) },
      { child: () => exitingChild(0, null), deadline: deadlineFor('stdio'), result: async () => ({ visible: false }) },
    ]
    for (const item of cases) {
      const root = tempRoot()
      const userData = join(root, 'userData')
      mkdirSync(userData)
      writeFileSync(join(userData, 'state'), 'retain')
      const report = await createHiddenWindowSmokeOwner(item.child, item.result, item.deadline, userData).settled
      expect(report.cleanup.userDataRemoved).toBe(false)
      expect(report.cleanup.tree).toBe('unverified')
      expect(existsSync(join(userData, 'state'))).toBe(true)
    }
  })

  it('sets isolated HOME and DSH_HOME and rejects unknown extra keys', () => {
    const home = join(tempRoot(), 'home')
    const env = hiddenWindowSmokeEnvironment({
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'must-not-copy',
      DSH_HOME: '/must-not-read',
      HOME: '/ambient-home',
      ELECTRON_RUN_AS_NODE: '1',
    }, home)
    expect(env.HOME).toBe(home)
    expect(env.DSH_HOME).toBe(home)
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(() => hiddenWindowSmokeEnvironment({ PATH: '/usr/bin' }, home, { DEEPSEEK_API_KEY: 'nope' }))
      .toThrow(/unknown field DEEPSEEK_API_KEY/)
  })

  it('declares a bundled Electron entry rather than a TypeScript Electron main', () => {
    expect(HIDDEN_WINDOW_SMOKE_SOURCE.endsWith('scripts/hidden-window-smoke.ts')).toBe(true)
    expect(HIDDEN_WINDOW_SMOKE_ENTRY.endsWith('out/hidden-window-smoke.mjs')).toBe(true)
    expect(HIDDEN_WINDOW_SMOKE_BUNDLE.endsWith('scripts/build-hidden-window-smoke.mjs')).toBe(true)
    expect(desktopWindowConstructorOptions('hidden')).toEqual({ show: false })
    expect(handleDesktopWindowActivate('hidden', {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore() { throw new Error('must not restore') },
      focus() { throw new Error('must not focus') },
    })).toBe('handled')
    expect(spawnHiddenWindowSmoke.toString()).toContain('requireHiddenWindowSmokeEntry')
    expect(spawnHiddenWindowSmoke.toString()).toContain('detached: false')
    expect(spawnHiddenWindowSmoke.toString()).not.toContain('tsx/esm')
    expect(spawnHiddenWindowSmoke.toString()).not.toContain('--import')
  })

  it('refuses to spawn Electron until the bundled ESM main exists', () => {
    if (existsSync(HIDDEN_WINDOW_SMOKE_ENTRY)) {
      expect(requireHiddenWindowSmokeEntry()).toBe(HIDDEN_WINDOW_SMOKE_ENTRY)
      return
    }
    expect(() => requireHiddenWindowSmokeEntry()).toThrow(/requires bundled/)
  })

  it('keeps exit 0 separate from acceptance FAIL for failed, visible, empty, and malformed payloads', async () => {
    const payloads: unknown[] = [
      { failed: true, message: 'hidden-window smoke captured an empty or nonpositive page' },
      { ...ACCEPTED_RESULT, visible: true },
      { ...ACCEPTED_RESULT, captureEmpty: true },
      { ...ACCEPTED_RESULT, extra: true },
      { visible: false, shownOnCreate: false, activate: 'handled', captureEmpty: false, captureWidth: 320 },
      { ...ACCEPTED_RESULT, captureWidth: 0 },
      { ...ACCEPTED_RESULT, captureHeight: 1.5 },
      { ...ACCEPTED_RESULT, activate: 'ignored' },
    ]
    for (const payload of payloads) {
      const root = tempRoot()
      const userData = join(root, 'userData')
      mkdirSync(userData)
      writeFileSync(join(userData, 'state'), 'retain')
      const report = await createHiddenWindowSmokeOwner(
        () => exitingChild(0, null),
        async () => payload,
        settledDeadline(),
        userData,
      ).settled
      expect(report.exitCode).toBe(0)
      expect(report.cleanup.process).toBe('direct-child-exited')
      expect(report.acceptance.status).not.toBe('accepted')
      expect(existsSync(join(userData, 'state'))).toBe(true)
    }
  })
})

describe('hidden-window smoke result parser', () => {
  it('accepts the exact hidden success payload', () => {
    expect(parseHiddenWindowSmokeResult(ACCEPTED_RESULT)).toEqual({
      status: 'accepted', captureWidth: 320, captureHeight: 240,
    })
  })

  it('records an explicit failed result arm', () => {
    expect(parseHiddenWindowSmokeResult({
      failed: true,
      message: 'hidden-window smoke became visible after capture',
    })).toEqual({
      status: 'failed',
      message: 'hidden-window smoke became visible after capture',
    })
  })

  it('rejects missing, extra, and mistyped fields', () => {
    expect(parseHiddenWindowSmokeResult(null).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult([]).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult({ ...ACCEPTED_RESULT, extra: 1 }).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult({
      visible: false, shownOnCreate: false, activate: 'handled', captureEmpty: false, captureWidth: 320,
    }).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult({ ...ACCEPTED_RESULT, visible: 'false' }).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult({ ...ACCEPTED_RESULT, shownOnCreate: true }).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult({ ...ACCEPTED_RESULT, activate: 'handled', captureEmpty: true }).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult({ ...ACCEPTED_RESULT, captureWidth: 0 }).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult({ ...ACCEPTED_RESULT, captureHeight: -1 }).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult({ ...ACCEPTED_RESULT, captureWidth: 1.5 }).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult({ ...ACCEPTED_RESULT, captureWidth: Number.NaN }).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult({ ...ACCEPTED_RESULT, captureHeight: Number.POSITIVE_INFINITY }).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult({ failed: true }).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult({ failed: false, message: 'nope' }).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResult({ failed: true, message: 'x', extra: true }).status).toBe('rejected')
    expect(parseHiddenWindowSmokeResultFile('not-json').status).toBe('rejected')
  })

  it('returns capture sizes only after the caller verdict accepts process and payload', async () => {
    const root = tempRoot()
    const userData = join(root, 'userData')
    mkdirSync(userData)
    const verdict = await runHiddenWindowSmoke(
      () => exitingChild(0, null),
      async () => ACCEPTED_RESULT,
      settledDeadline(),
      userData,
    )
    expect(verdict).toEqual({ captureWidth: 320, captureHeight: 240 })
  })

  it('rejects the callable runner for exit 0 with failed, visible, empty, or malformed payloads', async () => {
    const payloads: unknown[] = [
      { failed: true, message: 'hidden-window smoke captured an empty or nonpositive page' },
      { ...ACCEPTED_RESULT, visible: true },
      { ...ACCEPTED_RESULT, captureEmpty: true },
      { ...ACCEPTED_RESULT, extra: true },
    ]
    for (const payload of payloads) {
      const root = tempRoot()
      const userData = join(root, 'userData')
      mkdirSync(userData)
      writeFileSync(join(userData, 'state'), 'retain')
      await expect(runHiddenWindowSmoke(
        () => exitingChild(0, null),
        async () => payload,
        settledDeadline(),
        userData,
      )).rejects.toThrow(/payload was not accepted/)
      expect(existsSync(join(userData, 'state'))).toBe(true)
    }
  })

  it('rejects the caller verdict for nonzero exit even when the payload would parse', () => {
    expect(() => assertHiddenWindowSmokeAcceptance({
      exitCode: 1,
      signal: null,
      result: ACCEPTED_RESULT,
      acceptance: { status: 'accepted', captureWidth: 320, captureHeight: 240 },
      diagnostics: [],
      cleanup: {
        process: 'direct-child-exited',
        tree: 'unverified',
        userDataRemoved: false,
        reason: 'direct-child exit is not renderer tree quiescence',
      },
    })).toThrow(/did not exit 0/)
  })

  it('pins the smoke script to reject empty capture and post-capture visibility before writing success', () => {
    const source = readFileSync(HIDDEN_WINDOW_SMOKE_SOURCE, 'utf8')
    expect(source).toContain("throw new Error('hidden-window smoke became visible after capture')")
    expect(source).toContain("throw new Error('hidden-window smoke captured an empty or nonpositive page')")
    expect(source).toContain('captureEmpty: false')
    expect(source).toContain('shownOnCreate: false')
  })
})
