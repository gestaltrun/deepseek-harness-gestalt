interface RecognizableStreamProbe {
  push(chunk: Uint8Array): boolean
  finish(): boolean
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
  let rejectAbort!: (reason?: unknown) => void
  const halt = (): void => { rejectAbort(abortError(signal.reason)) }
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
    if (signal.aborted) halt()
    else signal.addEventListener('abort', halt, { once: true })
  })
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted])
      if (chunk.done) {
        if (probe.finish()) return
        throw new Error(incompleteMessage)
      }
      if (probe.push(chunk.value)) return
    }
  } finally {
    signal.removeEventListener('abort', halt)
    await reader.cancel().catch(() => {})
  }
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('phone stream verification was cancelled', { cause: reason })
}
