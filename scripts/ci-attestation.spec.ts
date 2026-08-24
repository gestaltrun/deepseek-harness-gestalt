import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import {
  completeCiCandidateAttestation,
  createCiEvidenceIdentity,
  decideCiEvidenceReuse,
} from './ci-attestation.ts'

const root = resolve(import.meta.dirname, '..')

describe('CI candidate attestation', () => {
  it('keys proof by the tree and every declared environment input', () => {
    const identity = createCiEvidenceIdentity(root)

    expect(identity).toMatchObject({ formatVersion: 1 })
    expect(identity.tree).toBe(execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: root,
      encoding: 'utf8',
    }).trim())
    for (const digest of [
      identity.lockfileDigest,
      identity.workflowPlannerDigest,
      identity.toolchainDigest,
      identity.gateInventoryDigest,
      identity.evidenceKey,
    ]) expect(digest).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('reuses only one complete exact attestation from the expected merge-group run', () => {
    const identity = createCiEvidenceIdentity(root)
    const attestation = completeCiCandidateAttestation(identity, 'owner/repo', 42)

    expect(decideCiEvidenceReuse(identity, attestation, 'owner/repo', 42)).toMatchObject({
      reused: true,
      reason: 'exact-candidate-proof',
      sourceRunId: 42,
    })
    for (const [field, value] of [
      ['tree', 'different-tree'],
      ['lockfileDigest', 'different-lock'],
      ['workflowPlannerDigest', 'different-workflow'],
      ['toolchainDigest', 'different-toolchain'],
      ['gateInventoryDigest', 'different-gates'],
      ['evidenceKey', 'different-key'],
    ] as const) {
      expect(decideCiEvidenceReuse(identity, { ...attestation, [field]: value }, 'owner/repo', 42))
        .toMatchObject({ reused: false, reason: `${field}-mismatch` })
    }
  })

  it('does not use commit identity or accept incomplete and foreign proof', () => {
    const identity = createCiEvidenceIdentity(root)
    const attestation = completeCiCandidateAttestation(identity, 'owner/repo', 42)

    expect(attestation).not.toHaveProperty('commitSha')
    expect(decideCiEvidenceReuse(identity, { ...attestation, complete: false }, 'owner/repo', 42))
      .toMatchObject({ reused: false, reason: 'attestation-invalid' })
    expect(decideCiEvidenceReuse(identity, attestation, 'other/repo', 42))
      .toMatchObject({ reused: false, reason: 'repository-mismatch' })
    expect(decideCiEvidenceReuse(identity, attestation, 'owner/repo', 43))
      .toMatchObject({ reused: false, reason: 'run-id-mismatch' })
  })

  it('changes each digest when its owned input changes', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'dsh-ci-identity-'))
    try {
      execFileSync('git', ['init'], { cwd: fixture })
      for (const path of [
        'pnpm-lock.yaml',
        '.github/workflows/ci.yml',
        'scripts/ci-plan.ts',
        'scripts/ci-risk-catalog.json',
        'package.json',
        'pnpm-workspace.yaml',
        'scripts/run-gates.ts',
        'vitest.config.ts',
        'vitest.snapshot.config.ts',
        'vitest.web.config.ts',
      ]) {
        const target = join(fixture, path)
        mkdirSync(resolve(target, '..'), { recursive: true })
        writeFileSync(target, `${path}\n`)
      }
      execFileSync('git', ['add', '.'], { cwd: fixture })
      execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'], { cwd: fixture })
      const before = createCiEvidenceIdentity(fixture)
      writeFileSync(join(fixture, 'scripts/run-gates.ts'), `${readFileSync(join(fixture, 'scripts/run-gates.ts'), 'utf8')}changed\n`)
      execFileSync('git', ['add', '.'], { cwd: fixture })
      execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'change'], { cwd: fixture })
      const after = createCiEvidenceIdentity(fixture)
      expect(after.tree).not.toBe(before.tree)
      expect(after.gateInventoryDigest).not.toBe(before.gateInventoryDigest)
      expect(after.evidenceKey).not.toBe(before.evidenceKey)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
