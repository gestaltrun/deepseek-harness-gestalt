# Explicit dependency preparation for repository checks

Issue #606 records the user's explicit KEEP decision to repair dependency self-installation encountered during #604. This is an independent repository-process fix, not a change to Python shutdown or the reviewed guidance patch.

## Baseline

Specification branch `codex/feature-doc-dependency-policy` starts at verified master `6d3b7a9d923f5d1fc7bcd3a2d89bcca942bdb522`. Keep one isolated writer and one specification PR. Refresh the shared integration base before final review; preserve user worktrees, dependency installations, credentials, and all unrelated changes.

## Evidence and scope

A real pnpm 11.7.0 offline fixture demonstrates that stale installed dependency state can make `pnpm run` install dependencies and execute installation lifecycle before the requested check. A prior production-only installation state can affect the arguments replayed by implicit installation. `CI=true` alone is not evidence of production installation. Noninteractive failure has multiple paths: prompt-mode refusal and an implicit install refusing to purge modules without a TTY are different errors. Do not generalize one into the other.

The intended owner is the repository's explicit pre-run dependency policy. Confirm the pinned pnpm version accepts the proposed `verifyDepsBeforeRun: error` workspace setting through both the supported configuration and a behavioral fixture. If unsupported, report that before choosing another mechanism.

## Acceptance criteria

1. Dependency checks remain enabled. When installed state is cold or stale, documentation and other repository checks fail clearly instead of installing, pruning, prompting, or running install lifecycle implicitly. Use an error policy, not an ignore/disable policy, if the pinned pnpm supports it.
2. Explicit preparation with the documented frozen-lockfile install remains supported. After preparation, the same requested check succeeds. Preserve the repository lockfile and legitimate production-package/deployment workflows; do not globally force dev dependencies into release artifacts.
3. Add deterministic offline regression evidence with local file dependencies and isolated configuration. Show the previous install policy mutates state and the new policy rejects stale state before mutation. Cover noninteractive execution, `CI=true`, retained dev-dependency sentinel/state, unchanged lockfile, no postinstall marker, and cold install followed by a successful check. Distinguish `pnpm run` and `pnpm exec` where the configuration applies. Do not run these experiments against the user's root node_modules.
4. Wire checkable policy acceptance into an executed top-level gate or existing repository constraint, including a negative control that rejects removal or weakening of the chosen policy. Avoid a hand-rolled replacement dependency manager, incidental package updates, and tests that only assert a YAML string without observing pnpm behavior. A deliberate higher-priority command-line or environment override can supersede workspace configuration; document this limitation and test it rather than claiming workspace policy is a security boundary. A wrapper that starts after pnpm's pre-run hook cannot protect that earlier hook. Do not add ineffective environment sanitization or modify global user settings.
5. Document explicit cold-worktree preparation and stale-state recovery at the owning contributor reference. Explain that routine checks do not repair dependencies and that `CI=true` is not the universal workaround for installation-mode errors. Keep instructions concise and conditional; do not add repeated installation to every skill.
6. Add or update the owning process Agent Note with alternatives, consequences, scoped supersession review, bilingual counterparts, and pairing metadata as required. Do not copy diagnostic transcripts, user config, cache paths, or credentials into committed prose.
7. Validate focused regression and policy gates, affected documentation gates, lint, and whitespace with exact recorded results. Preserve missing-state failure as useful diagnostics rather than bypassing it to run checks. Explicit dependency preparation is allowed only in the owned isolated worktree.
8. Independent review must verify the actual behavior and absence of unintended release/install changes. Complete writer retrospective and user keep/drop decisions before any additional environment work. Pass PR checks and then merge-queue candidate checks without bypass; only confirmed GitHub merge and Issue closure count as delivered.

## Completion boundary

Deliver only the smallest proven dependency-policy repair. SDK fix #604/#605 can proceed independently. Overall delivery still includes this user-approved work and guidance #602/#603. No tags, package publication, signing, deployment, private-session inspection, or global user-setting changes are authorized.
