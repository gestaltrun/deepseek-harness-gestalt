/**
 * Observe Web Host wait facts without letting diagnostic I/O skip recovery.
 * @module @deepseek-ai/dsh-desktop/observe-web-host-exit
 */
import { formatWebHostExit, type RunningWebHost } from './spawn-web-host.ts'

const RECOVERY_FAILED = 'web host exit recovery failed'

function containRecoveryFailure(_error: unknown): void {
  try {
    process.emitWarning(RECOVERY_FAILED, {
      type: 'WebHostExitRecoveryFailed',
      code: 'DSH_WEB_HOST_EXIT_RECOVERY_FAILED',
    })
  } catch {
    // emitWarning was replaced; recovery failure is already contained.
  }
}

/**
 * Observe one Host generation exit. Diagnostic logging must not skip recovery.
 * A throwing logger is contained. Recovery is `Promise.resolve().then(onExit)` so a
 * synchronous throw cannot run inside `running.exited.then`. The observer contains
 * both a synchronous throw and a rejected Promise from `onExit` and emits a fixed
 * warning code without the recovery error text.
 *
 * @param running Host whose {@link RunningWebHost.exited} publishes wait facts.
 * @param log Optional smoke/diagnostic sink. Absence of a writable sink is not a product-readable cause.
 * @param onExit Recovery. Must run even when `log` throws.
 */
export function observeWebHostExit(
  running: Pick<RunningWebHost, 'exited'>,
  log: (line: string) => void,
  onExit: () => void | Promise<void>,
): void {
  void running.exited.then((record) => {
    try {
      log(formatWebHostExit(record))
    } catch {
      // Diagnostic write failed; Host recovery must still run.
    }
    void Promise.resolve().then(() => {
      try {
        return onExit()
      } catch (error) {
        containRecoveryFailure(error)
        return
      }
    }).then(
      () => undefined,
      (error: unknown) => { containRecoveryFailure(error) },
    )
  })
}
