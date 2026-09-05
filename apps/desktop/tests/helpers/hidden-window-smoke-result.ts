const SUCCESS_KEYS = [
  'visible',
  'shownOnCreate',
  'activate',
  'captureEmpty',
  'captureWidth',
  'captureHeight',
] as const

const FAILED_KEYS = ['failed', 'message'] as const

/** Hidden-window smoke result-file payload after strict parse. */
export type HiddenWindowSmokeParsedResult =
  | {
    readonly status: 'accepted'
    readonly captureWidth: number
    readonly captureHeight: number
  }
  | {
    readonly status: 'failed'
    readonly message: string
  }
  | {
    readonly status: 'rejected'
    readonly reason: string
  }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keysOf(value: Record<string, unknown>): readonly string[] {
  return Object.keys(value).toSorted()
}

function isFinitePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value > 0
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false
  const wanted = [...expected].toSorted()
  return actual.every((key, index) => key === wanted[index])
}

/**
 * Parse one hidden-window smoke result-file value.
 * Extra, missing, or mistyped fields are rejected. A `failed` object is not acceptance.
 *
 * @param value JSON value from the result file.
 * @returns Accepted capture sizes, an explicit failed arm, or a rejection reason.
 */
export function parseHiddenWindowSmokeResult(value: unknown): HiddenWindowSmokeParsedResult {
  if (!isRecord(value)) return { status: 'rejected', reason: 'result is not an object' }
  const keys = keysOf(value)
  if (keys.includes('failed')) {
    if (!sameKeys(keys, FAILED_KEYS)) return { status: 'rejected', reason: 'failed result has extra or missing fields' }
    if (value.failed !== true) return { status: 'rejected', reason: 'failed must be true' }
    if (typeof value.message !== 'string' || value.message.length === 0) {
      return { status: 'rejected', reason: 'failed message must be a non-empty string' }
    }
    return { status: 'failed', message: value.message }
  }
  if (!sameKeys(keys, SUCCESS_KEYS)) return { status: 'rejected', reason: 'success result has extra or missing fields' }
  if (value.visible !== false) return { status: 'rejected', reason: 'visible must be false' }
  if (value.shownOnCreate !== false) return { status: 'rejected', reason: 'shownOnCreate must be false' }
  if (value.activate !== 'handled') return { status: 'rejected', reason: "activate must be 'handled'" }
  if (value.captureEmpty !== false) return { status: 'rejected', reason: 'captureEmpty must be false' }
  if (!isFinitePositiveInteger(value.captureWidth)) {
    return { status: 'rejected', reason: 'captureWidth must be a finite positive integer' }
  }
  if (!isFinitePositiveInteger(value.captureHeight)) {
    return { status: 'rejected', reason: 'captureHeight must be a finite positive integer' }
  }
  return {
    status: 'accepted',
    captureWidth: value.captureWidth,
    captureHeight: value.captureHeight,
  }
}

/**
 * Parse the result-file JSON text at the file boundary.
 *
 * @param text Entire result-file contents.
 * @returns Parsed result, or rejected when the text is not JSON.
 */
export function parseHiddenWindowSmokeResultFile(text: string): HiddenWindowSmokeParsedResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // JSON.parse SyntaxError: the result file is not JSON, so the payload cannot be accepted.
    return { status: 'rejected', reason: 'result is not JSON' }
  }
  return parseHiddenWindowSmokeResult(value)
}
