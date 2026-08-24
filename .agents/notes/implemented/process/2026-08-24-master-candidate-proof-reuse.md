# Agent Note: Master candidate proof reuse

Status: implemented

English | [中文](2026-08-24-master-candidate-proof-reuse.zh.md)

## Problem

Merge Queue proves a synthetic candidate commit, while the landed master commit may have a different commit identifier despite producing identical files. Re-running the complete matrix after an exact proof wastes the longest platform clocks, but trusting only a commit, artifact name, or partial environment digest can reuse stale evidence after CI semantics change.

## Decision

Candidate preflight computes a versioned evidence identity from the Git tree plus separate digests for `pnpm-lock.yaml`, the CI workflow and Planner, the Node/pnpm toolchain declarations, and the executable gate inventory. The evidence key hashes those fields. It intentionally omits commit SHA: tree identity is the content equivalence required between the queue candidate and landed master.

After every exhaustive dependency succeeds, `candidate verdict` completes the identity with its repository, merge-group run id, event, and successful verdict, then publishes an artifact named by tree. Master preflight queries only same-repository artifacts with that tree, confirms that the source run is a merge-group run with a successful `candidate verdict`, downloads the record, and requires every identity field to match exactly.

An exact match selects the bounded `master reuse smoke`, which verifies the checked-out tree and reports the source proof. Missing, expired, unavailable, malformed, foreign, incomplete, or mismatched proof selects every exhaustive lane. `master evidence verdict` accepts only the smoke for exact reuse and otherwise requires the complete fallback, including native Windows and macOS Electron.

## Alternatives considered

**Match merge-group and master commit SHA.** Rejected because equivalent candidate and landed trees may have different commit metadata.

**Match only tree and lockfile.** Rejected because workflow, Planner, toolchain, or gate changes can alter what the same source tree proves.

**Fail master when the proof service is unavailable.** Rejected because proof lookup is an optimization; uncertainty must increase validation by selecting the exhaustive fallback.

## Consequences

Every master CI run publishes a structured reuse decision naming the source run or fallback reason. New workflow, Planner, toolchain, or gate inventory inputs must join the owned digest lists and their contract tests. Exact candidate proof removes duplicate exhaustive work without weakening a cold or degraded path.
