import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildGateReport,
  classifyGateFailure,
  isTransientInfrastructureFailure,
  parseCiCacheEvidence,
  writeGateReport,
  type CiFailureClassification,
} from './ci-evidence.ts'
import type { Gate, GateResult } from './run-gates.ts'

function result(
  id: string,
  options: {
    output?: string
    signalCode?: NodeJS.Signals
    allowFailure?: boolean
    failureDomain?: 'infrastructure'
    status?: GateResult['status']
  } = {},
): GateResult {
  const gate: Gate = {
    id,
    label: id,
    displayCommand: `run ${id}`,
    command: process.execPath,
    args: [],
    ...options.allowFailure === true ? { allowFailure: true } : {},
    ...options.failureDomain === undefined ? {} : { failureDomain: options.failureDomain },
  }
  const status = options.status ?? 'failed'
  return {
    gate,
    status,
    durationMs: 12,
    output: options.output === undefined ? [] : [{ stream: 'stderr', text: options.output }],
    exitCode: status === 'passed' ? 0 : 1,
    signalCode: options.signalCode ?? null,
  }
}

describe('CI failure classification', () => {
  it.each([
    ['coverage', {}, 'coverage'],
    ['snapshot', {}, 'snapshot'],
    ['module-graph', {}, 'generated-drift'],
    ['constraints', {}, 'workflow-policy'],
    ['test', {}, 'product-regression'],
    ['test', { signalCode: 'SIGTERM' }, 'runner-contamination'],
    ['test', {
      output: 'Client.Timeout exceeded while awaiting headers',
      failureDomain: 'infrastructure',
    }, 'transient-infrastructure'],
  ] as const)('classifies %s diagnostics', (id, options, expected: CiFailureClassification) => {
    expect(classifyGateFailure(result(id, options))).toBe(expected)
  })

  it('does not classify an ordinary assertion as transient infrastructure', () => {
    expect(classifyGateFailure(result('test', { output: 'AssertionError: expected 1 to be 2' })))
      .toBe('product-regression')
  })

  it('does not infer infrastructure ownership from a transport-shaped product failure', () => {
    expect(classifyGateFailure(result('test', { output: 'ECONNRESET' }))).toBe('product-regression')
  })

  it('keeps the transient signature allowlist narrow', () => {
    expect(isTransientInfrastructureFailure('Client.Timeout exceeded while awaiting headers')).toBe(true)
    expect(isTransientInfrastructureFailure([
      'gyp ERR! stack AssertionError [ERR_ASSERTION]',
      'assert(!this.paused)',
      'at Parser.finish (/pnpm/dist/node_modules/undici/lib/dispatcher/client-h1.js:302:5)',
    ].join('\n'))).toBe(true)
    expect(isTransientInfrastructureFailure('AssertionError: request timed out in application code')).toBe(false)
    expect(isTransientInfrastructureFailure('AssertionError: assert(!this.paused)')).toBe(false)
  })
})

describe('CI gate reports', () => {
  it('parses exact, fallback, and cold cache outcomes', () => {
    expect(parseCiCacheEvidence(JSON.stringify([
      { id: 'pnpm-store', primaryKey: 'exact', matchedKey: 'exact', exactHit: true },
      { id: 'playwright', primaryKey: 'new', matchedKey: 'old', exactHit: false },
      { id: 'cold', primaryKey: 'cold', matchedKey: '', exactHit: false },
    ]))).toHaveLength(3)
    expect(parseCiCacheEvidence(undefined)).toEqual([])
    expect(() => parseCiCacheEvidence('[{"id":"missing-fields"}]'))
      .toThrow('CI cache evidence entry 0 is invalid')
  })

  it('records actual first blocking failure and all stage durations', () => {
    const declared = [
      result('slow-product'),
      result('observational', { allowFailure: true }),
      result('coverage'),
    ]
    const report = buildGateReport(
      'ci-coverage',
      declared,
      [declared[1]!, declared[2]!, declared[0]!],
      new Date('2026-08-24T00:00:00.000Z'),
      new Date('2026-08-24T00:00:01.000Z'),
      ['ci-gates-node-24', 'ci-gates-node-24'],
      [{ id: 'pnpm-store', primaryKey: 'exact', matchedKey: 'fallback', exactHit: false }],
    )

    expect(report).toMatchObject({
      formatVersion: 1,
      status: 'failed',
      durationMs: 1000,
      firstFailure: { gateId: 'coverage', classification: 'coverage' },
      artifactRefs: ['ci-gates-node-24'],
      caches: [{ id: 'pnpm-store', primaryKey: 'exact', matchedKey: 'fallback', exactHit: false }],
    })
    expect(report.gates.map(gate => gate.durationMs)).toEqual([12, 12, 12])
  })

  it('writes deterministic JSON to an owned directory', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'dsh-ci-report-'))
    const path = resolve(directory, 'nested', 'report.json')
    try {
      const passed = result('test', { status: 'passed' })
      const report = buildGateReport(
        'ci-static',
        [passed],
        [passed],
        new Date('2026-08-24T00:00:00.000Z'),
        new Date('2026-08-24T00:00:00.012Z'),
        [],
      )
      writeGateReport(path, report)

      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(report)
      expect(readFileSync(path, 'utf8')).toMatch(/\n$/u)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
