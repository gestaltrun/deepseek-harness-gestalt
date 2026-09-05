# Agent Note: Explicit dependency preparation for repository checks

Status: implemented

English | [中文](2026-09-05-dependency-preparation-policy.zh.md)

## Problem

pnpm 11 defaults `verify-deps-before-run` to `install`. A top-level `pnpm run` or `pnpm exec` with cold or stale installed state may run an implicit `pnpm install`, including installation lifecycle, before the requested command. Replayed installation settings can also prune dev dependencies needed by checks. Noninteractive failures have separate causes: `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` reports a dependency-verification refusal, while `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` reports an install that needs permission to purge `node_modules`. `CI=true` affects install defaults and confirmation behavior; it does not by itself select production dependencies or repair stale state.

## Decision

`pnpm-workspace.yaml` declares `verifyDepsBeforeRun: error`. Repository checks retain pnpm's consistency verification and fail when installed state is cold or stale; contributors prepare it with `pnpm install --frozen-lockfile` in the same environment class. `scripts/verify-dependency-policy.ts` runs independent offline `file:` fixtures through top-level `pnpm run` and `pnpm exec` in local and `CI=true` environments. It isolates the home, store, cache, user config, and global directories; bounds each process; compares lockfile bytes; and verifies stale and cold rejection, retained dev dependencies, skipped requested commands and lifecycle, frozen-install recovery, default implicit installation, and deliberate environment and CLI precedence. The gate also proves that equal-length contents receive different hashes so a size-only comparison cannot satisfy its mutation evidence.

## Alternatives considered

**Keep the pnpm default and document it.** No configuration change is needed. Every cold or stale checkout then mutates dependencies as a side effect of its first check, and the production-replay purge stays one environment variable away.

**Set `verifyDepsBeforeRun: prompt`.** Interactive contributors get a choice. Noninteractive check runs — CI, hooks, scheduler-spawned gates — fail with a prompt-specific error, and the acceptance requires noninteractive failure to carry actionable install guidance instead of a confirmation request.

**Wrap every repository pnpm invocation to force the policy.** A wrapper started by a script runs after pnpm's own pre-run hook and cannot protect that hook; forcing the setting through environment sanitization would misrepresent precedence as a security boundary. The gate documents and tests override precedence instead.

## Consequences

Routine checks never mutate installed dependencies; cold worktrees and stale checkouts fail with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` and the documented frozen install as the repair. Production and deployment workflows that deliberately install with `--prod` keep working — the policy governs pre-run verification only, not install modes. A user who deliberately exports `pnpm_config_verify_deps_before_run` or passes the CLI flag overrides the repository default by pnpm's documented precedence; that is a chosen environment, not a defect this policy claims to block. Every script launched by another pnpm script inherits `pnpm_config_verify_deps_before_run=false`, so nested `pnpm run` calls do not re-verify — the policy's guarantee applies at the top-level invocation.
