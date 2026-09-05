interface RecognizableStreamProbe {
  push(chunk: Uint8Array): boolean
  finish(): boolean
}

/** One bounded inspection result whose body replays every byte already read. */
export interface RecognizableStreamInspection {
  readonly recognizable: boolean
  readonly body: ReadableStream<Uint8Array>
  readonly failure?: Error
}

/**
 * Inspect a live stream without discarding its prefix. The returned body first
 * replays every inspected chunk, then continues from the same upstream reader.
 * @param body - Live upstream byte stream.
 * @param signal - Caller cancellation for inspection.
 * @param probe - Bounded format recognizer.
 * @param incompleteMessage - Failure used when EOF arrives before recognition.
 * @returns recognition facts plus a replayable continuation owned by the caller.
 */
export async function inspectRecognizable(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  probe: RecognizableStreamProbe,
  incompleteMessage: string,
): Promise<RecognizableStreamInspection> {
  const reader = body.getReader()
  const prefix: Uint8Array[] = []
  let sourceDone = false
  let failure: Error | undefined
  const abortRace = rejectWhenAborted(signal)
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), abortRace.promise])
      if (chunk.done) {
        sourceDone = true
        try {
          if (!probe.finish()) failure = new Error(incompleteMessage)
        } catch (error) {
          failure = asError(error)
        }
        break
      }
      prefix.push(chunk.value)
      try {
        if (probe.push(chunk.value)) break
      } catch (error) {
        failure = asError(error)
        break
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    abortRace.dispose()
  }
  return {
    recognizable: failure === undefined,
    body: replay(reader, prefix, sourceDone),
    ...(failure === undefined ? {} : { failure }),
  }
}

/**
 * Read a live byte stream until its format-specific probe recognizes one complete unit.
 * Reader cancellation settles before the operation returns or rejects.
 * @param body - live upstream response body.
 * @param signal - caller cancellation for the body read.
 * @param probe - bounded format-specific recognizer.
 * @param incompleteMessage - error text used when EOF arrives before recognition.
 * @returns completion after one unit is recognized and reader cancellation settles.
 */
export async function readUntilRecognizable(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  probe: RecognizableStreamProbe,
  incompleteMessage: string,
): Promise<void> {
  const reader = body.getReader()
  const abortRace = rejectWhenAborted(signal)
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), abortRace.promise])
      if (chunk.done) {
        if (probe.finish()) return
        throw new Error(incompleteMessage)
      }
      if (probe.push(chunk.value)) return
    }
  } finally {
    abortRace.dispose()
    await reader.cancel().catch(() => {})
  }
}

/** Create an abort rejection and exact listener disposer.
 * @param signal - Signal whose current or future abort rejects the promise.
 * @returns abort promise plus idempotent listener disposal.
 */
export function rejectWhenAborted(signal: AbortSignal): {
  readonly promise: Promise<never>
  dispose(): void
} {
  let rejectAbort!: (reason?: unknown) => void
  const halt = (): void => { rejectAbort(abortError(signal.reason)) }
  const promise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
    if (signal.aborted) halt()
    else signal.addEventListener('abort', halt, { once: true })
  })
  return {
    promise,
    dispose() { signal.removeEventListener('abort', halt) },
  }
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('phone stream verification was cancelled', { cause: reason })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function replay(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: readonly Uint8Array[],
  sourceDone: boolean,
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = prefix[index]
      if (chunk !== undefined) {
        index += 1
        controller.enqueue(chunk)
        return
      }
      if (sourceDone) {
        controller.close()
        return
      }
      const next = await reader.read()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  }, { highWaterMark: 0 })
}
