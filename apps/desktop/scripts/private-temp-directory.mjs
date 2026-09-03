import { access, chmod, mkdtemp, rm } from 'node:fs/promises'

/**
 * Run an operation in a private temporary directory and remove the directory
 * after success or failure.
 * @template T
 * @param {string} prefix - OS temporary-directory prefix.
 * @param {(directory: string) => Promise<T>} operation - operation that owns the directory while running.
 * @returns {Promise<T>} the operation result after verified cleanup.
 */
export async function withPrivateTempDirectory(prefix, operation) {
  const directory = await mkdtemp(prefix)
  let result
  let operationError
  try {
    await chmod(directory, 0o700)
    result = await operation(directory)
  } catch (error) {
    operationError = error
  }

  let cleanupError
  try {
    await rm(directory, { recursive: true, force: true })
    await assertMissing(directory)
  } catch (error) {
    cleanupError = error
  }

  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([operationError, cleanupError], 'private temporary directory operation and cleanup failed')
  }
  if (operationError !== undefined) throw operationError
  if (cleanupError !== undefined) throw cleanupError
  return result
}

async function assertMissing(path) {
  try {
    await access(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`temporary path survived cleanup: ${path}`)
}
