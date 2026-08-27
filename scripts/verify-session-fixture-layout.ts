#!/usr/bin/env node
/** Read-only verification for canonical repository session fixtures. */

import { resolve } from 'node:path'
import type { SessionFixtureLayout } from './session-fixture-layout.ts'
import { inspectSessionFixtureLayouts } from './session-fixture-layout.ts'

/** Result of checking a complete session-fixture inventory. */
export interface SessionFixtureLayoutVerification {
  /** Number of session fixtures inspected. */
  inspected: number
  /** Repository-relative paths whose bytes differ from their canonical projection. */
  nonCanonical: string[]
}

/**
 * Compare inspected session fixtures with their canonical projections.
 * @param fixtures - complete repository session-fixture inventory.
 * @returns the inspected count and every non-canonical path.
 */
export function verifySessionFixtureLayouts(
  fixtures: readonly SessionFixtureLayout[],
): SessionFixtureLayoutVerification {
  return {
    inspected: fixtures.length,
    nonCanonical: fixtures
      .filter(fixture => fixture.source !== fixture.canonical)
      .map(fixture => fixture.path),
  }
}

function main(): void {
  const root = resolve(import.meta.dirname, '..')
  const result = verifySessionFixtureLayouts(inspectSessionFixtureLayouts(root))
  if (result.nonCanonical.length > 0) {
    console.error('session fixture layout is not canonical:')
    for (const path of result.nonCanonical) console.error(`  ${path}`)
    console.error('Run `pnpm run migrate:packed-session-fixtures` and commit the mechanical rewrite.')
    process.exitCode = 1
    return
  }
  console.log(`session fixture layout: ${String(result.inspected)} canonical fixture(s)`)
}

if (import.meta.main) main()
