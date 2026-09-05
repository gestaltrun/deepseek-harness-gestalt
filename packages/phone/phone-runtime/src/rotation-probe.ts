/**
 * Retire one owned rotation-probe slot after settlement.
 * Success and rejection share this compare-then-delete so a replaced token is left alone.
 */

/**
 * Delete `id` only when the map still holds `expected`.
 * @param probes - Live probe map for the current generation.
 * @param id - Device whose probe may still occupy the map.
 * @param expected - Slot token this callback owns.
 */
export function retireOwnedProbe<K, V>(probes: Map<K, V>, id: K, expected: V): void {
  if (probes.get(id) === expected) probes.delete(id)
}
