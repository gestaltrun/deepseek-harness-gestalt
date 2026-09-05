/**
 * Live-read dispatch fence for one `io()` after coordinate awaits and before RPC.
 * Capture liveness is a closed none|capture union resolved at the `io()` caller.
 */

import { PhoneDevicesError } from './errors.ts'

/** Non-capture io does not read a capture grant at dispatch. */
export interface IoDispatchCaptureNone {
  readonly kind: 'none'
}

/** Capture-source io compares the admitted grant to a live getter. */
export interface IoDispatchCaptureGranted {
  readonly kind: 'capture'
  readonly admitted: object
  getCurrent(): object | undefined
}

/** Closed capture arm for dispatch: either no grant or a live-checked grant. */
export type IoDispatchCapture = IoDispatchCaptureNone | IoDispatchCaptureGranted

/**
 * Refuse dispatch when the admitted incarnation or capture grant no longer matches live tokens.
 * @param options - Admitted incarnation, live incarnation getter, and closed capture arm.
 */
export function assertIoDispatchAuthority(options: {
  readonly admittedIncarnation: object
  getCurrentIncarnation(): object | undefined
  readonly capture: IoDispatchCapture
}): void {
  if (options.getCurrentIncarnation() !== options.admittedIncarnation) {
    throw new PhoneDevicesError('PHONE_ABORTED', 'device incarnation changed before io dispatch')
  }
  switch (options.capture.kind) {
    case 'none':
      return
    case 'capture': {
      if (options.capture.getCurrent() !== options.capture.admitted) {
        throw new PhoneDevicesError('PHONE_PROTOCOL', 'capture authority changed before io dispatch')
      }
      return
    }
    /* v8 ignore next -- IoDispatchCapture is the closed none|capture union. */
    default:
      return assertNever(options.capture)
  }
}

/* v8 ignore next -- IoDispatchCapture is the closed none|capture union. */
function assertNever(value: never): never {
  throw new PhoneDevicesError('PHONE_PROTOCOL', `unsupported io dispatch capture ${JSON.stringify(value)}`)
}
