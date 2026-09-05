import type { ChildProcess } from 'node:child_process'
import {
  parseHiddenWindowSmokeResult,
  type HiddenWindowSmokeParsedResult,
} from './hidden-window-smoke-result.ts'

/** Bounded, redacted diagnostic retained after a smoke child settles. */
export interface HiddenWindowSmokeDiagnostic {
  readonly source: 'stdout' | 'stderr' | 'result' | 'exit'
  readonly message: string
}

/**
 * Direct-child settlement is process-only. `tree` is always `unverified`.
 * `userDataRemoved` is always `false`: this owner never deletes the isolated root.
 */
export type HiddenWindowSmokeCleanup =
  | {
    readonly process: 'direct-child-exited'
    readonly tree: 'unverified'
    readonly userDataRemoved: false
    readonly reason: string
  }
  | {
    readonly process: 'forced'
    readonly tree: 'unverified'
    readonly userDataRemoved: false
    readonly reason: string
  }
  | {
    readonly process: 'unverified'
    readonly tree: 'unverified'
    readonly userDataRemoved: false
    readonly reason: string
  }

export type HiddenWindowSmokeAcceptance =
  | HiddenWindowSmokeParsedResult
  | { readonly status: 'missing'; readonly reason: string }

/** Process-only settlement of one owned ChildProcess. Not renderer/GPU tree proof. */
export interface HiddenWindowSmokeReport {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly result: unknown
  readonly acceptance: HiddenWindowSmokeAcceptance
  readonly diagnostics: readonly HiddenWindowSmokeDiagnostic[]
  readonly cleanup: HiddenWindowSmokeCleanup
}

/**
 * Caller-supplied bounded waits for result, exit, and stdio lanes.
 * `settle` must bound `operation` independently; awaiting it alone is not a deadline.
 */
export interface HiddenWindowSmokeDeadline {
  /**
   * @param lane Which owned wait this deadline bounds.
   * @param operation The wait to bound. Must not be the only source of settlement.
   * @returns Settled value or `expired` without treating expiry as success.
   */
  settle<T>(
    lane: 'result' | 'exit' | 'stdio',
    operation: Promise<T>,
  ): Promise<{ readonly status: 'settled'; readonly value: T } | { readonly status: 'expired' }>
}

export interface HiddenWindowSmokeOwner {
  readonly child: ChildProcess | undefined
  readonly settled: Promise<HiddenWindowSmokeReport>
  /** Contained late diagnostics after the frozen report is published. Not report mutation. */
  readonly lateDiagnostics: readonly HiddenWindowSmokeDiagnostic[]
}

const MAX_DIAGNOSTIC = 256
const MAX_LATE_DIAGNOSTICS = 8
const MAX_LATE_DIAGNOSTIC_BYTES = 1024
const ALLOWED_CHILD_ENV = new Set([
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
])

function redact(value: unknown): string {
  return String(value).replaceAll(/[A-Za-z0-9+/=_-]{24,}/g, '[redacted]').slice(0, MAX_DIAGNOSTIC)
}

function createDeferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((onResolve) => { resolve = onResolve })
  return { promise, resolve }
}

function acceptanceOf(result: unknown): HiddenWindowSmokeAcceptance {
  if (result === undefined) return { status: 'missing', reason: 'result missing' }
  return parseHiddenWindowSmokeResult(result)
}

function unverified(reason: string, extras: {
  readonly exitCode?: number | null
  readonly signal?: NodeJS.Signals | null
  readonly result?: unknown
  readonly diagnostics?: readonly HiddenWindowSmokeDiagnostic[]
} = {}): HiddenWindowSmokeReport {
  const diagnostics: readonly HiddenWindowSmokeDiagnostic[] = extras.diagnostics
    ?? [{ source: 'exit', message: redact(reason) }]
  return Object.freeze({
    exitCode: extras.exitCode ?? null,
    signal: extras.signal ?? null,
    result: extras.result,
    acceptance: acceptanceOf(extras.result),
    diagnostics: Object.freeze(diagnostics),
    cleanup: Object.freeze({
      process: 'unverified',
      tree: 'unverified',
      userDataRemoved: false,
      reason: redact(reason),
    }),
  })
}

interface StreamObservation {
  readonly promise: Promise<{ readonly tail: string; readonly error?: string }>
  readonly abandon: () => void
}

function collectStream(child: ChildProcess, stream: 'stdout' | 'stderr'): StreamObservation {
  const readable = child[stream]
  if (readable === null) {
    return { promise: Promise.resolve({ tail: '' }), abandon() {} }
  }
  let tail = ''
  let settled = false
  let failed: string | undefined
  let resolve!: (value: { readonly tail: string; readonly error?: string }) => void
  const promise = new Promise<{ readonly tail: string; readonly error?: string }>((onResolve) => {
    resolve = onResolve
  })
  const finish = () => {
    if (settled) return
    settled = true
    readable.off('data', onData)
    readable.off('error', onError)
    readable.off('end', onEnd)
    readable.off('close', onClose)
    if (failed === undefined) resolve({ tail: redact(tail) })
    else resolve({ tail: redact(tail), error: redact(failed) })
  }
  const onData = (chunk: Buffer) => {
    tail = `${tail}${chunk.toString('utf8')}`.slice(-MAX_DIAGNOSTIC)
  }
  const onError = (error: Error) => {
    failed = error.message
    finish()
  }
  const onEnd = () => { finish() }
  const onClose = () => { finish() }
  readable.on('data', onData)
  readable.on('error', onError)
  readable.on('end', onEnd)
  readable.on('close', onClose)
  return {
    promise,
    abandon() {
      failed ??= 'stdio observation abandoned'
      finish()
    },
  }
}

interface DirectChildObservation {
  readonly promise: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
  readonly snapshot: () => { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined
  readonly childError: () => string | undefined
  readonly abandon: () => void
}

function containLateChildError(
  child: ChildProcess,
  recordLate: (message: string) => void,
): void {
  const onError = (error: Error) => {
    recordLate(`late child error: ${redact(error)}`)
  }
  const onTerminal = () => {
    child.off('error', onError)
    child.off('exit', onTerminal)
    child.off('close', onTerminal)
  }
  child.on('error', onError)
  child.on('exit', onTerminal)
  child.on('close', onTerminal)
}

function isAlreadyTerminated(child: ChildProcess): boolean {
  // ChildProcess.killed means a signal was sent, not that the process exited.
  return typeof child.exitCode === 'number' || child.signalCode != null
}

function observeDirectChild(
  child: ChildProcess,
  recordLate: (message: string) => void,
): DirectChildObservation {
  let childError: string | undefined
  let snapshot: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined
  let settled = false
  let abandoned = false
  const alreadyExited = child.exitCode
  const alreadySignaled = child.signalCode
  if (typeof alreadyExited === 'number') snapshot = { code: alreadyExited, signal: alreadySignaled ?? null }
  else if (alreadySignaled != null) snapshot = { code: alreadyExited ?? null, signal: alreadySignaled }
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => { finish(code, signal) }
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => { finish(code, signal) }
  const onError = (error: Error) => { childError = redact(error) }
  let resolvePromise!: (value: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => void
  const promise = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((onResolve) => {
    resolvePromise = onResolve
  })
  const detach = () => {
    child.off('exit', onExit)
    child.off('close', onClose)
    child.off('error', onError)
  }
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled || abandoned) return
    settled = true
    snapshot = { code, signal }
    detach()
    resolvePromise({ code, signal })
  }
  if (snapshot !== undefined) {
    settled = true
    resolvePromise(snapshot)
    return {
      promise,
      snapshot: () => snapshot,
      childError: () => childError,
      abandon() {},
    }
  }
  child.on('exit', onExit)
  child.on('close', onClose)
  child.on('error', onError)
  return {
    promise,
    snapshot: () => snapshot,
    childError: () => childError,
    abandon() {
      if (settled || abandoned) return
      abandoned = true
      detach()
      if (typeof child.exitCode === 'number' || child.signalCode != null) return
      containLateChildError(child, recordLate)
    },
  }
}

async function boundedKill(
  child: ChildProcess,
  signal: NodeJS.Signals,
  exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>,
  deadline: HiddenWindowSmokeDeadline,
): Promise<{ readonly status: 'settled'; readonly value: { readonly code: number | null; readonly signal: NodeJS.Signals | null } } | { readonly status: 'expired' } | { readonly status: 'failed'; readonly reason: string }> {
  if (isAlreadyTerminated(child)) {
    try {
      return await deadline.settle('exit', exit)
    } catch (error) {
      return { status: 'failed', reason: redact(error) }
    }
  }
  try {
    const signaled = child.kill(signal)
    if (!signaled) return { status: 'failed', reason: `${signal} was not delivered` }
  } catch (error) {
    return { status: 'failed', reason: redact(error) }
  }
  try {
    return await deadline.settle('exit', exit)
  } catch (error) {
    return { status: 'failed', reason: redact(error) }
  }
}

async function stopAndJoin(
  child: ChildProcess,
  observed: DirectChildObservation,
  deadline: HiddenWindowSmokeDeadline,
  parsed: unknown,
  diagnostics: HiddenWindowSmokeDiagnostic[],
  reason: string,
): Promise<HiddenWindowSmokeReport> {
  const already = observed.snapshot()
  if (already !== undefined || isAlreadyTerminated(child)) {
    observed.abandon()
    const terminal = already ?? { code: child.exitCode, signal: child.signalCode }
    diagnostics.push({ source: 'exit', message: reason })
    return Object.freeze({
      exitCode: terminal.code,
      signal: terminal.signal,
      result: parsed,
      acceptance: acceptanceOf(parsed),
      diagnostics: Object.freeze(diagnostics),
      cleanup: Object.freeze({
        process: terminal.code === 0 && terminal.signal === null ? 'direct-child-exited' as const : 'unverified' as const,
        tree: 'unverified' as const,
        userDataRemoved: false as const,
        reason: 'direct-child exit is not renderer tree quiescence',
      }),
    })
  }
  diagnostics.push({ source: 'exit', message: reason })
  const term = await boundedKill(child, 'SIGTERM', observed.promise, deadline)
  if (term.status === 'settled') {
    return Object.freeze({
      exitCode: term.value.code,
      signal: term.value.signal,
      result: parsed,
      acceptance: acceptanceOf(parsed),
      diagnostics: Object.freeze(diagnostics.concat({ source: 'exit', message: 'direct child required SIGTERM' })),
      cleanup: Object.freeze({
        process: 'forced' as const,
        tree: 'unverified' as const,
        userDataRemoved: false as const,
        reason: 'direct child required SIGTERM',
      }),
    })
  }
  const kill = await boundedKill(child, 'SIGKILL', observed.promise, deadline)
  if (kill.status === 'settled') {
    return Object.freeze({
      exitCode: kill.value.code,
      signal: kill.value.signal,
      result: parsed,
      acceptance: acceptanceOf(parsed),
      diagnostics: Object.freeze(diagnostics.concat({ source: 'exit', message: 'direct child required SIGKILL' })),
      cleanup: Object.freeze({
        process: 'unverified' as const,
        tree: 'unverified' as const,
        userDataRemoved: false as const,
        reason: 'direct child joined after SIGKILL is not renderer tree quiescence',
      }),
    })
  }
  observed.abandon()
  return unverified(kill.status === 'failed' ? kill.reason : 'direct child exit unverified after SIGKILL', {
    result: parsed,
    diagnostics,
  })
}

/**
 * Own one exact Electron ChildProcess for the hidden-window smoke.
 *
 * Allocates `settled` first. Spawn and exit/stdio observers run before this function
 * returns. `readResult`, deadline waits, and kill run on a later microtask.
 * Direct-child exit is not renderer or GPU quiescence. The userData root is never removed.
 *
 * @param spawnChild Factory for the exact ChildProcess to own.
 * @param readResult Foreign result reader; invoked after the owner object is returned.
 * @param deadline Bounded waits for result, stdio, and exit.
 * @param _userData Isolated userData root retained by this owner (never deleted).
 * @returns The spawned child when spawn succeeded, a Promise that later reports process-only cleanup,
 * and a late-diagnostic sink that does not mutate the frozen report.
 */
export function createHiddenWindowSmokeOwner(
  spawnChild: () => ChildProcess,
  readResult: () => Promise<unknown>,
  deadline: HiddenWindowSmokeDeadline,
  _userData: string,
): HiddenWindowSmokeOwner {
  const deferred = createDeferred<HiddenWindowSmokeReport>()
  const lateDiagnostics: HiddenWindowSmokeDiagnostic[] = []
  let lateBytes = 0
  const recordLate = (source: HiddenWindowSmokeDiagnostic['source'], message: string) => {
    if (lateDiagnostics.length >= MAX_LATE_DIAGNOSTICS) return
    if (lateBytes + message.length > MAX_LATE_DIAGNOSTIC_BYTES) return
    lateBytes += message.length
    lateDiagnostics.push(Object.freeze({ source, message }))
  }
  let child: ChildProcess | undefined
  try {
    child = spawnChild()
  } catch (error) {
    deferred.resolve(unverified(`spawn failed: ${redact(error)}`))
    return { child: undefined, settled: deferred.promise, lateDiagnostics }
  }
  const stdout = collectStream(child, 'stdout')
  const stderr = collectStream(child, 'stderr')
  const observed = observeDirectChild(child, (message) => { recordLate('exit', message) })
  queueMicrotask(() => {
    let result: Promise<unknown>
    try {
      result = readResult()
    } catch (error) {
      result = Promise.reject(error instanceof Error ? error : new Error(redact(error)))
    }
    const resultWatch = observeOriginalResult(result, recordLate)
    void settleOwnedChild({ child, stdout, stderr, observed, result, resultWatch, deadline, recordLate }).then(
      deferred.resolve,
      (error: unknown) => { deferred.resolve(unverified(`settlement failed: ${redact(error)}`)) },
    )
  })
  return { child, settled: deferred.promise, lateDiagnostics }
}

function observeOriginalResult(
  result: Promise<unknown>,
  recordLate: (source: HiddenWindowSmokeDiagnostic['source'], message: string) => void,
): { deadlineFinished: boolean; promptError: string | undefined } {
  const watch: { deadlineFinished: boolean; promptError: string | undefined } = {
    deadlineFinished: false,
    promptError: undefined,
  }
  void result.then(
    () => {
      if (watch.deadlineFinished) recordLate('result', 'late result settled after deadline')
    },
    (error: unknown) => {
      if (watch.deadlineFinished) recordLate('result', `late result rejected: ${redact(error)}`)
      else watch.promptError = redact(error)
    },
  )
  return watch
}

async function settleOwnedChild(input: {
  readonly child: ChildProcess
  readonly stdout: StreamObservation
  readonly stderr: StreamObservation
  readonly observed: DirectChildObservation
  readonly result: Promise<unknown>
  readonly resultWatch: { deadlineFinished: boolean; promptError: string | undefined }
  readonly deadline: HiddenWindowSmokeDeadline
  readonly recordLate: (source: HiddenWindowSmokeDiagnostic['source'], message: string) => void
}): Promise<HiddenWindowSmokeReport> {
  const diagnostics: HiddenWindowSmokeDiagnostic[] = []
  let parsed: unknown
  try {
    const resultLane = await input.deadline.settle('result', input.result)
    if (resultLane.status === 'settled') parsed = resultLane.value
    else diagnostics.push({ source: 'result', message: 'result settlement expired' })
  } catch (error) {
    diagnostics.push({ source: 'result', message: redact(error) })
  } finally {
    input.resultWatch.deadlineFinished = true
    if (input.resultWatch.promptError !== undefined
      && !diagnostics.some(item => item.source === 'result' && item.message === input.resultWatch.promptError)) {
      diagnostics.push({ source: 'result', message: input.resultWatch.promptError })
    }
  }

  let stdioSettled = false
  try {
    const stdioLane = await input.deadline.settle('stdio', Promise.all([input.stdout.promise, input.stderr.promise]))
    if (stdioLane.status === 'settled') {
      const [out, err] = stdioLane.value
      if (out.tail.length > 0) diagnostics.push({ source: 'stdout', message: out.tail })
      if (err.tail.length > 0) diagnostics.push({ source: 'stderr', message: err.tail })
      if (out.error !== undefined) diagnostics.push({ source: 'stdout', message: out.error })
      if (err.error !== undefined) diagnostics.push({ source: 'stderr', message: err.error })
      stdioSettled = out.error === undefined && err.error === undefined
    } else {
      input.stdout.abandon()
      input.stderr.abandon()
      diagnostics.push({ source: 'stderr', message: 'stdio drain expired' })
    }
  } catch (error) {
    input.stdout.abandon()
    input.stderr.abandon()
    diagnostics.push({ source: 'stderr', message: redact(error) })
  }

  const childError = input.observed.childError()
  if (childError !== undefined) diagnostics.push({ source: 'exit', message: `child error: ${childError}` })

  let exitLane: { readonly status: 'settled'; readonly value: { readonly code: number | null; readonly signal: NodeJS.Signals | null } } | { readonly status: 'expired' }
  try {
    exitLane = await input.deadline.settle('exit', input.observed.promise)
  } catch (error) {
    return await stopAndJoin(
      input.child,
      input.observed,
      input.deadline,
      parsed,
      diagnostics,
      `exit deadline failed: ${redact(error)}`,
    )
  }

  if (exitLane.status === 'expired') {
    const already = input.observed.snapshot()
    if (already !== undefined) {
      input.observed.abandon()
      diagnostics.push({ source: 'exit', message: 'direct child already exited before exit-deadline expiry' })
      return Object.freeze({
        exitCode: already.code,
        signal: already.signal,
        result: parsed,
        acceptance: acceptanceOf(parsed),
        diagnostics: Object.freeze(diagnostics),
        cleanup: Object.freeze({
          process: already.code === 0 && already.signal === null ? 'direct-child-exited' as const : 'unverified' as const,
          tree: 'unverified' as const,
          userDataRemoved: false as const,
          reason: 'direct-child exit is not renderer tree quiescence',
        }),
      })
    }
    return await stopAndJoin(
      input.child,
      input.observed,
      input.deadline,
      parsed,
      diagnostics,
      'direct child exit expired',
    )
  }

  input.observed.abandon()
  if (childError !== undefined || exitLane.value.code !== 0 || exitLane.value.signal !== null || parsed === undefined || !stdioSettled) {
    return Object.freeze({
      exitCode: exitLane.value.code,
      signal: exitLane.value.signal,
      result: parsed,
      acceptance: acceptanceOf(parsed),
      diagnostics: Object.freeze(diagnostics),
      cleanup: Object.freeze({
        process: 'unverified' as const,
        tree: 'unverified' as const,
        userDataRemoved: false as const,
        reason: childError === undefined
          ? 'direct-child exit is not renderer tree quiescence'
          : 'child error is not an exit',
      }),
    })
  }

  return Object.freeze({
    exitCode: exitLane.value.code,
    signal: exitLane.value.signal,
    result: parsed,
    acceptance: acceptanceOf(parsed),
    diagnostics: Object.freeze(diagnostics),
    cleanup: Object.freeze({
      process: 'direct-child-exited' as const,
      tree: 'unverified' as const,
      userDataRemoved: false as const,
      reason: 'direct-child exit is not renderer tree quiescence',
    }),
  })
}

/**
 * Build a child environment from an explicit allowlist and isolated HOME / DSH_HOME roots.
 * Does not read or copy credential files. Extra keys must be allowlisted names.
 *
 * @param source Ambient process env; only allowlisted keys are copied.
 * @param home Isolated HOME, USERPROFILE, and DSH_HOME.
 * @param extra Additional allowlisted keys. Unknown names throw.
 * @returns A new env object. Does not inherit `ELECTRON_RUN_AS_NODE`.
 * @throws If `extra` contains a key outside the allowlist and HOME/DSH_HOME names.
 */
export function hiddenWindowSmokeEnvironment(
  source: NodeJS.ProcessEnv,
  home: string,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  for (const name of Object.keys(extra)) {
    if (!ALLOWED_CHILD_ENV.has(name) && name !== 'DSH_HOME' && name !== 'HOME' && name !== 'USERPROFILE') {
      throw new TypeError(`hidden-window smoke extra environment contains unknown field ${name}`)
    }
  }
  const env: NodeJS.ProcessEnv = {}
  for (const name of ALLOWED_CHILD_ENV) {
    const value = source[name]
    if (value !== undefined && value.length > 0) env[name] = value
  }
  env.HOME = home
  env.USERPROFILE = home
  env.DSH_HOME = home
  for (const [name, value] of Object.entries(extra)) {
    if (name === 'HOME' || name === 'USERPROFILE' || name === 'DSH_HOME') continue
    env[name] = value
  }
  return env
}
