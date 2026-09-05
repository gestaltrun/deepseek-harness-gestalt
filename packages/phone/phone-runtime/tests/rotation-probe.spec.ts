import { describe, expect, it } from 'vitest'
import { retireOwnedProbe } from '../src/rotation-probe.ts'

describe('retireOwnedProbe', () => {
  it('deletes only the owned slot', () => {
    const owned = {}
    const probes = new Map<string, object>([['a', owned]])
    retireOwnedProbe(probes, 'a', owned)
    expect(probes.has('a')).toBe(false)
  })

  it('leaves a missing id alone', () => {
    const owned = {}
    const probes = new Map<string, object>()
    retireOwnedProbe(probes, 'a', owned)
    expect(probes.size).toBe(0)
  })

  it('leaves a replaced token in the map', () => {
    const owned = {}
    const replacement = {}
    const probes = new Map<string, object>([['a', replacement]])
    retireOwnedProbe(probes, 'a', owned)
    expect(probes.get('a')).toBe(replacement)
  })
})
