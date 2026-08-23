# Agent Note: Hosted Windows complete lane uses two top-level gate workers

Status: implemented
Archived: 2026-08-23

English | [中文](2026-08-20-hosted-windows-two-gate-workers.zh.md)

## Problem

The native Windows complete inventory runs forty-five gates, including the full per-file 100% coverage pair. With one top-level worker those gates execute strictly in series on `windows-latest`, so wall-clock time is the sum of every gate. One successful hosted run spent 1,113 seconds in instrumented coverage and 238 seconds in the exempt-heavy gate after it. Shrinking that inventory is not available: native Windows still has to enforce the supported-source coverage denominator.

## Decision

`windows-native` sets `DSH_GATE_CONCURRENCY` to `2` on hosted `windows-latest` and on the `dsh-win-ci` failover pool. Hosted `DSH_COVERAGE_MAX_WORKERS` stays `1`, so the coverage pair still receives one Vitest worker each when they overlap. Both coverage gates `needs: ['build']` so instrumented Vitest does not load `lib/` while tsdown is still writing it. Production site and Electron runtime e2e may overlap the build. Exempt-heavy cases must not set a shorter per-test timeout than `DSH_COVERAGE_TEST_TIMEOUT_MS`; a 20s `change-scope` budget timed out on the first overlapping hosted run after #210. Instrumented Vitest fan-out on Windows remains the bound in the [native Windows pull-request CI](2026-08-08-native-windows-pull-request-ci.md) note. The required Wine job and the `all-checks-passed` graph are unchanged.

## Alternatives considered

**Raise hosted `DSH_COVERAGE_MAX_WORKERS` to 2 or more.** A budget of 2 still assigns one Vitest worker to each coverage gate. A budget of 3 is the first value that gives the instrumented gate two workers, and two or more concurrent instrumented workers already exited or hit Node 24's CJS lexer fatal on 16-core hosts.

**Drop coverage from `check:ci:windows-complete`.** That shortens the hosted job by omitting the Windows coverage inventory rather than scheduling the same gates with more overlap.

**Keep one top-level worker on hosted Windows.** This preserves the serial 32-minute complete run. The failover pool already overlapped the same gates at two top-level workers.

**Leave coverage unsynchronized with build.** Rejected: the first hosted concurrency=2 run started instrumented coverage while tsdown still held `lib/`, and a Vitest worker then exited unexpectedly.

## Consequences

Ready gates overlap on both pools after their declared dependencies. Coverage waits for `build`; the two coverage gates may then overlap each other and hide later observational work. The supported-source 100% inventory, per-test 30-second budgets, and one hosted instrumented Vitest worker are unchanged. [Standard hosted primary CI](2026-08-18-standard-hosted-primary-ci.md) still owns the `windows-latest` selector.
