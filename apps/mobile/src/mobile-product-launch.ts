/** Production launch indirection used by built-entry tests to supply explicit composition inputs. */

/**
 * Start the operated Mobile product composition.
 * @param start - production composition owner resolved by the bundled entry.
 * @returns product startup completion.
 */
export function launchMobileProduct(start: () => Promise<void>): Promise<void> {
  return start()
}
