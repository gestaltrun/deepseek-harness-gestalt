# Agent Note: Web evidence fails early and freezes before recording

Status: implemented

English | [中文](2026-08-27-web-evidence-fast-feedback.zh.md)

## Problem

Local Web verification could spend a full build and Chromium run before discovering a missing Playwright executable, a malformed replay fixture, or a noncanonical session fixture. Contributors also had to reconstruct the built Server, disposable Workspace, served-commit check, restart, and cleanup steps by hand. When semantic review happened after a real-model smoke or GIF capture, a review fix invalidated that expensive evidence and forced the flow to repeat.

## Decision

The root commands expose three explicit early checks. `test:web:setup` installs the exact Playwright headless Chromium revision declared by the Web workspace. `test:web:focus` accepts exactly one repository-relative file in the Web snapshot inventory, runs the complete build once, and executes only that file in read-only replay mode. `assertReplayFixture()` resolves the same primary and child scripts used at runtime, requires exact script and call counts, and optionally compares browser-visible assistant text using only ordered `text-delta` chunks.

Canonical session-fixture validation is a read-only core preflight gate. `verify-session-fixture-layout` scans the repository inventory before build and browser jobs; the Web snapshot lane no longer owns a late duplicate of that invariant.

`accept:web` is the single built-Web acceptance supervisor. It requires a clean committed worktree, reuses only a build record whose revision and artifact digest match HEAD, otherwise performs the complete build, and launches the built CLI in one owned temporary root with isolated Home, Agents, bundled skills, and Workspace directories. It registers the Workspace through the supported Host API, verifies the revision embedded in the served Sidebar bundle, retains the exact child process, supports `status`, `restart [port]`, and `stop`, and deletes only its owned temporary state. The default run is keyless. The explicit `--copy-model-config` option blindly copies only the two approved regular configuration files with owner-only permissions; Browser and Ego profile state are never copied.

GUI delivery orders evidence by cost and invalidation risk: deterministic checks, a non-recording smoke, semantic Standards and Spec review, fixes and re-review, exact-head freeze, then final real-model GIF recording and publication. A code change after the freeze restarts review before recording. The served revision is verified before the first real-model call or captured frame.

## Alternatives considered

**Keep browser installation implicit.** A missing or mismatched cached executable then appears as a test failure after unrelated setup work, and a locally installed browser may not be the revision Playwright actually launches.

**Validate fixture layout only in the snapshot lane.** That preserves the invariant but reports repository-wide fixture corruption after build work and makes a Web-specific job own a source-wide format rule.

**Use shell snippets for acceptance.** Separate PID discovery, temporary paths, RPC calls, and cleanup make it easy to restart the wrong process, serve stale artifacts, or leave normal application state carrying the test.

**Record before review.** Review fixes change the demonstrated code, so the recording no longer substantiates the pull-request head.

## Consequences

Fixture and local-environment failures become focused diagnostics before Chromium. One command now creates a reproducible built-Web surface whose commit, process, Workspace, and cleanup ownership are explicit. Final GIF recording starts later but repeats less often because semantic fixes land before model calls and frame capture.

The acceptance supervisor deliberately does not select an Ego profile, drive the UI, authorize credentials, or publish media. Those remain external actions with their existing authorization and evidence requirements.
