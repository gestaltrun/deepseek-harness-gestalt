import type { ChildProcess } from 'node:child_process'
import {
  createHiddenWindowSmokeOwner,
  type HiddenWindowSmokeDeadline,
  type HiddenWindowSmokeReport,
} from './hidden-window-smoke-owner.ts'

/** Capture sizes returned only after process facts and parsed payload both pass. */
export interface HiddenWindowSmokeVerdict {
  readonly captureWidth: number
  readonly captureHeight: number
}

/**
 * Caller-shaped acceptance of one owned smoke report.
 * Process facts stay separate from the parsed payload: both must pass.
 *
 * @param report Frozen owner report. `tree` remains unverified and is not a pass condition.
 * @returns Validated capture sizes.
 * @throws If exit is nonzero, signaled, not `direct-child-exited`, or the payload is not accepted.
 */
export function assertHiddenWindowSmokeAcceptance(report: HiddenWindowSmokeReport): HiddenWindowSmokeVerdict {
  if (report.exitCode !== 0 || report.signal !== null) {
    throw new Error('hidden-window smoke process did not exit 0 without a signal')
  }
  if (report.cleanup.process !== 'direct-child-exited') {
    throw new Error('hidden-window smoke process is not a direct-child exit')
  }
  switch (report.acceptance.status) {
    case 'accepted':
      return {
        captureWidth: report.acceptance.captureWidth,
        captureHeight: report.acceptance.captureHeight,
      }
    case 'failed':
      throw new Error(`hidden-window smoke payload was not accepted: ${report.acceptance.message}`)
    case 'missing':
      throw new Error(`hidden-window smoke payload was not accepted: ${report.acceptance.reason}`)
    case 'rejected':
      throw new Error(`hidden-window smoke payload was not accepted: ${report.acceptance.reason}`)
    default:
      return assertNever(report.acceptance)
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected hidden-window smoke acceptance: ${String(value)}`)
}

/**
 * Own one smoke child, wait for the owner report, then apply the caller verdict.
 * Launch, result read, and deadlines are injected; this function does not select a launcher.
 *
 * @param spawnChild Factory for the exact ChildProcess.
 * @param readResult Foreign result reader, invoked after the owner is returned.
 * @param deadline Bounded waits for result, stdio, and exit.
 * @param userData Isolated userData root retained by the owner.
 * @returns Validated capture sizes when process and payload both pass.
 * @throws If ownership settlement or `assertHiddenWindowSmokeAcceptance` rejects.
 */
export async function runHiddenWindowSmoke(
  spawnChild: () => ChildProcess,
  readResult: () => Promise<unknown>,
  deadline: HiddenWindowSmokeDeadline,
  userData: string,
): Promise<HiddenWindowSmokeVerdict> {
  const owner = createHiddenWindowSmokeOwner(spawnChild, readResult, deadline, userData)
  const report = await owner.settled
  return assertHiddenWindowSmokeAcceptance(report)
}
