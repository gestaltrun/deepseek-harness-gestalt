# Agent Note: Explicit dependency preparation for repository checks

Status: implemented

English | [中文](2026-09-05-dependency-preparation-policy.zh.md)

## Problem

pnpm 11 defaults `verify-deps-before-run` to `install`. Any `pnpm run` or `pnpm exec` whose installed state is cold or stale first runs a full implicit `pnpm install`: it executes the root `postinstall` (`install-lefthook`), and it replays the previous install's flags — a checkout last installed with `--prod`/`pnpm_config_production=true` gets `pnpm install --production`, pruning dev dependencies the check needed. A settings drift (for example `publicHoistPattern`) routes the implicit install into a modules purge that cannot be confirmed without a TTY and fails with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`; `verifyDepsBeforeRun: prompt` instead fails with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`. These are two different noninteractive failure paths. `CI=true` alone is none of these: it only defaults `frozen-lockfile` and disables the purge confirmation prompt.

## Decision

`pnpm-workspace.yaml` declares `verifyDepsBeforeRun: error`. Repository checks keep the dependency consistency check and fail loudly when installed state is cold or stale; preparation is always an explicit `pnpm install --frozen-lockfile` in the same environment class (CI-installed state carries `enableGlobalVirtualStore: false`, which a non-CI run reports as a changed setting). `scripts/verify-dependency-policy.ts` is the executed gate: it runs an offline `file:`-dependency fixture through `pnpm run` and `pnpm exec` in default, `CI=true`, and cold states, asserts the error code, the retained dev-dependency sentinel, an unchanged lockfile, and zero implicit install lifecycle, then proves the negative control — the identical fixture without the policy silently installs. The gate strips the inherited `pnpm_config_verify_deps_before_run` (pnpm's script launcher sets it to `false` for child scripts) so the fixture is governed by its own workspace configuration, and it separately demonstrates that a deliberate environment override still wins.

## Alternatives considered

**Keep the pnpm default and document it.** No configuration change is needed. Every cold or stale checkout then mutates dependencies as a side effect of its first check, and the production-replay purge stays one environment variable away.

**Set `verifyDepsBeforeRun: prompt`.** Interactive contributors get a choice. Noninteractive check runs — CI, hooks, scheduler-spawned gates — fail with a prompt-specific error, and the acceptance requires noninteractive failure to carry actionable install guidance instead of a confirmation request.

**Wrap every repository pnpm invocation to force the policy.** A wrapper started by a script runs after pnpm's own pre-run hook and cannot protect that hook; forcing the setting through environment sanitization would misrepresent precedence as a security boundary. The gate documents and tests override precedence instead.

## Consequences

Routine checks never mutate installed dependencies; cold worktrees and stale checkouts fail with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` and the documented frozen install as the repair. Production and deployment workflows that deliberately install with `--prod` keep working — the policy governs pre-run verification only, not install modes. A user who deliberately exports `pnpm_config_verify_deps_before_run` or passes the CLI flag overrides the repository default by pnpm's documented precedence; that is a chosen environment, not a defect this policy claims to block. Every script launched by another pnpm script inherits `pnpm_config_verify_deps_before_run=false`, so nested `pnpm run` calls do not re-verify — the policy's guarantee applies at the top-level invocation.
