import { describe, expect, it } from 'vitest'
import { CorsOriginPolicy } from '../src/cors-origin.ts'

describe('exact CORS Origin policy', () => {
  it('matches standard and custom tuple origins without admitting opaque origins', () => {
    const policy = new CorsOriginPolicy(
      ['https://platform.example', 'https://localhost', 'capacitor://localhost'],
      'Test HTTP',
    )

    expect(policy.match('https://localhost')).toBe('https://localhost')
    expect(policy.match('capacitor://localhost')).toBe('capacitor://localhost')
    expect(policy.match('null')).toBeUndefined()
    expect(policy.match('https://localhost/path')).toBeUndefined()
    expect(policy.match('https://attacker.example')).toBeUndefined()
  })

  it('fails loud for empty, invalid, or duplicate configuration', () => {
    expect(() => new CorsOriginPolicy([], 'Test HTTP')).toThrow('origins configuration is required')
    expect(() => new CorsOriginPolicy(['null'], 'Test HTTP')).toThrow('origin is invalid')
    expect(() => new CorsOriginPolicy(['https://localhost', 'https://localhost'], 'Test HTTP'))
      .toThrow('origin is duplicated')
  })
})
