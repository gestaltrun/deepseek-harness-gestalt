/** Lifecycle primitives owned by the Desktop Electron acceptance runner. */
import { spawn, spawnSync } from 'node:child_process'
import { open, readFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'

function asError(value) {
  return value instanceof Error ? value : new Error(String(value))
}

function delay(milliseconds) {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function terminateProcessTree(child, closed, graceMs) {
  if (child.pid === undefined) return false
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (result.status !== 0 && !/not found|no running instance/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(`taskkill failed for owned tree ${String(child.pid)}: ${result.stderr.trim()}`)
    }
    await closed
    return true
  }
  if (!processGroupExists(child.pid)) return false
  signalProcessGroup(child.pid, 'SIGTERM')
  const exitedDuringGrace = await Promise.race([
    closed.then(() => true),
    delay(graceMs).then(() => false),
  ])
  if (!exitedDuringGrace || processGroupExists(child.pid)) signalProcessGroup(child.pid, 'SIGKILL')
  await closed
  const deadline = Date.now() + 5_000
  while (processGroupExists(child.pid) && Date.now() < deadline) await delay(10)
  if (processGroupExists(child.pid)) throw new Error(`owned process group ${String(child.pid)} survived termination`)
  return true
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

function processGroupOf(pid) {
  const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' })
  if (result.status !== 0) return undefined
  const pgid = Number(result.stdout.trim())
  return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined
}

/**
 * Terminate one recorded owned process tree and wait for it to disappear.
 * @param {number} pid - recently recorded owned process id.
 * @param {number} graceMs - graceful termination interval before force kill.
 * @returns {Promise<boolean>} whether a live process required termination.
 */
async function terminateRecordedProcessTree(pid, graceMs = 2_000) {
  if (!processExists(pid)) return false
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    const deadline = Date.now() + 5_000
    while (processExists(pid) && Date.now() < deadline) await delay(10)
    if (processExists(pid)) throw new Error(`owned process tree ${String(pid)} survived taskkill`)
    return true
  }
  const pgid = processGroupOf(pid)
  const ownGroup = processGroupOf(process.pid)
  if (pgid === undefined) return false
  if (pgid === ownGroup) throw new Error(`refusing to terminate the runner's own process group ${String(pgid)}`)
  signalProcessGroup(pgid, 'SIGTERM')
  const graceDeadline = Date.now() + graceMs
  while (processGroupExists(pgid) && Date.now() < graceDeadline) await delay(10)
  if (processGroupExists(pgid)) signalProcessGroup(pgid, 'SIGKILL')
  const deadline = Date.now() + 5_000
  while (processGroupExists(pgid) && Date.now() < deadline) await delay(10)
  if (processGroupExists(pgid)) throw new Error(`owned process group ${String(pgid)} survived termination`)
  return true
}

/**
 * Require recorded ownership evidence and force every surviving recorded tree to quiescence.
 * @param {string} file - owned-processes JSON artifact.
 * @param {readonly string[]} requiredKeys - process identities this scenario must record.
 * @returns {Promise<{ pids: readonly number[], forced: readonly number[] }>} recorded and force-terminated ids.
 */
export async function quiesceRecordedProcesses(file, requiredKeys) {
  let owned = {}
  const errors = []
  try {
    owned = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    errors.push(new Error(`owned process evidence is missing or invalid at ${file}`, { cause: error }))
  }
  const pids = []
  for (const key of requiredKeys) {
    const pid = owned?.[key]
    if (!Number.isSafeInteger(pid) || pid <= 0) errors.push(new Error(`owned process evidence omitted ${key}`))
    else pids.push(pid)
  }
  const naturalDeadline = Date.now() + 10_000
  while (pids.some(processExists) && Date.now() < naturalDeadline) await delay(100)
  const forced = []
  for (const pid of new Set(pids)) {
    try {
      if (await terminateRecordedProcessTree(pid)) forced.push(pid)
    } catch (error) {
      errors.push(asError(error))
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'owned process evidence or quiescence failed')
  return { pids, forced }
}

/**
 * Run every independent teardown obligation and retain all failures.
 * @param {readonly { name: string, run: () => void | Promise<void> }[]} steps - ordered cleanup obligations.
 * @returns {Promise<{ outcomes: readonly { name: string, ok: boolean, error?: string }[], errors: readonly Error[] }>} settled cleanup evidence.
 */
export async function settleCleanupSteps(steps) {
  const outcomes = []
  const errors = []
  for (const step of steps) {
    try {
      await step.run()
      outcomes.push({ name: step.name, ok: true })
    } catch (error) {
      const failure = asError(error)
      errors.push(failure)
      outcomes.push({ name: step.name, ok: false, error: failure.message })
    }
  }
  return { outcomes, errors }
}

/** A released port lease was claimed by a process the runner does not own. */
export class PortHandoffCollision extends Error {}

async function reserveLoopbackPort(excluded) {
  for (;;) {
    const server = createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error('port lease exposed no TCP address')
    }
    if (excluded.has(address.port)) {
      await new Promise((resolve, reject) => {
        server.close(error => { if (error === undefined) resolve(); else reject(error) })
      })
      continue
    }
    let released = false
    return {
      port: address.port,
      async release() {
        if (released) return
        released = true
        await new Promise((resolve, reject) => {
          server.close(error => { if (error === undefined) resolve(); else reject(error) })
        })
      },
    }
  }
}

/**
 * Reserve distinct fake/CDP ports until launch and retry only verified ownership collisions.
 * @template T
 * @param {(ports: { fakePort: number, cdpPort: number }, attempt: number) => T | Promise<T>} run - one launch attempt after both leases close.
 * @returns {Promise<T>} first attempt that establishes port ownership.
 */
export async function withDistinctPortHandoff(run) {
  const maxAttempts = 3
  const excluded = new Set()
  let lastCollision
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const fake = await reserveLoopbackPort(excluded)
    excluded.add(fake.port)
    let cdp
    try {
      cdp = await reserveLoopbackPort(excluded)
    } catch (error) {
      await fake.release()
      throw error
    }
    excluded.add(cdp.port)
    const released = await Promise.allSettled([fake.release(), cdp.release()])
    const releaseErrors = released.flatMap(result => result.status === 'rejected' ? [asError(result.reason)] : [])
    if (releaseErrors.length > 0) throw new AggregateError(releaseErrors, 'port lease release failed')
    try {
      return await run({ fakePort: fake.port, cdpPort: cdp.port }, attempt)
    } catch (error) {
      if (!(error instanceof PortHandoffCollision)) throw error
      lastCollision = error
    }
  }
  throw new PortHandoffCollision(
    `port ownership collision persisted for ${String(maxAttempts)} attempts: ${lastCollision?.message ?? 'unknown collision'}`,
  )
}

async function loopbackPortAcceptsConnections(port) {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (error) => {
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET') resolve(false)
      else reject(error)
    })
    socket.setTimeout(1_000, () => {
      socket.destroy()
      reject(new Error(`timed out while checking loopback port ${String(port)}`))
    })
  })
}

/**
 * Verify the fake process identity through its external ownership endpoint.
 * @param {number} port - fakemobilecli loopback port.
 * @param {string} ownerToken - attempt-specific token written into the staged fixture.
 * @returns {Promise<{ pid: number }>} verified fake process identity.
 */
export async function readOwnedFakeProcess(port, ownerToken) {
  let record
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/__test/pid`)
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    record = await response.json()
  } catch (error) {
    throw new Error('fakemobilecli port ownership verification failed', { cause: error })
  }
  if (typeof record?.pid !== 'number' || !Number.isSafeInteger(record.pid)
    || record.ownerToken !== ownerToken) {
    throw new Error('fakemobilecli port ownership verification failed')
  }
  return { pid: record.pid }
}

/**
 * Retry a port handoff only when a launch log identifies an ownership/bind failure and one handed-off port still accepts connections.
 * @template T
 * @param {string} name - scenario name included in terminal collision diagnostics.
 * @param {(ports: { fakePort: number, cdpPort: number }, attempt: number) => Promise<{ value: T, runnerLog: string }>} run - one real launch attempt and its drained runner log.
 * @returns {Promise<T>} first attempt without verified collision evidence.
 */
export async function runWithVerifiedPortHandoff(name, run) {
  return await withDistinctPortHandoff(async (ports, attempt) => {
    const observed = await run(ports, attempt)
    const collisionEvidence = /port ownership verification failed|EADDRINUSE|address already in use|failed to bind/i
      .test(observed.runnerLog)
    if (collisionEvidence) {
      const occupied = await Promise.all([
        loopbackPortAcceptsConnections(ports.fakePort),
        loopbackPortAcceptsConnections(ports.cdpPort),
      ])
      if (occupied.some(Boolean)) {
        throw new PortHandoffCollision(`${name} attempt ${String(attempt)} lost port ownership`)
      }
    }
    return observed.value
  })
}

/**
 * Run one owned process tree while mirroring output through a serial file writer. Completion waits for child close, inherited-pipe drain, and writer flush; cancellation or a write failure terminates the tree first.
 * @param {string} command - executable path or command name.
 * @param {readonly string[]} args - child arguments.
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, logFile: string, signal?: AbortSignal, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, terminateGraceMs?: number }} options - launch and log ownership.
 * @returns {Promise<number>} child exit code after tree and log settlement.
 */
export async function runLogged(command, args, options) {
  if (options.signal?.aborted === true) throw asError(options.signal.reason ?? new Error('child command aborted'))
  const log = await open(options.logFile, 'w', 0o600)
  let writes = Promise.resolve()
  let spawnError
  let writeError
  let abortError
  let termination
  let child
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
  } catch (error) {
    await log.close()
    throw error
  }
  const closed = new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error })
    child.once('close', (code, signal) => {
      resolve({ code, signal })
    })
  })
  const requestTermination = () => {
    termination ??= terminateProcessTree(child, closed, options.terminateGraceMs ?? 2_000)
    return termination
  }
  const onAbort = () => {
    abortError = asError(options.signal?.reason ?? new Error('child command aborted'))
    void requestTermination()
  }
  const onData = (stream, chunk) => {
    stream.write(chunk)
    writes = writes.then(async () => { await log.write(chunk) }).catch((error) => {
      writeError ??= asError(error)
      void requestTermination()
    })
  }
  child.stdout?.on('data', chunk => { onData(options.stdout ?? process.stdout, chunk) })
  child.stderr?.on('data', chunk => { onData(options.stderr ?? process.stderr, chunk) })
  if (options.signal?.aborted === true) onAbort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })
  const outcome = await closed
  options.signal?.removeEventListener('abort', onAbort)
  const settlementErrors = []
  if (termination !== undefined) {
    try { await termination } catch (error) { settlementErrors.push(asError(error)) }
  }
  try {
    await writes
  } catch (error) {
    settlementErrors.push(asError(error))
  } finally {
    try { await log.close() } catch (error) { settlementErrors.push(asError(error)) }
  }
  if (spawnError !== undefined) settlementErrors.push(spawnError)
  if (writeError !== undefined) settlementErrors.push(writeError)
  if (abortError !== undefined) settlementErrors.push(abortError)
  else if (outcome.signal !== null) settlementErrors.push(new Error(`${command} exited on ${outcome.signal}`))
  if (settlementErrors.length === 1) throw settlementErrors[0]
  if (settlementErrors.length > 1) throw new AggregateError(settlementErrors, `${command} process/log settlement failed`)
  if (process.platform !== 'win32' && child.pid !== undefined && processGroupExists(child.pid)) {
    await requestTermination()
    throw new Error(`${command} left an owned descendant running after exit`)
  }
  return outcome.code ?? 1
}
