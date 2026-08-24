# Agent Note: CI failover runbook — hosted pools → in-house pool

Status: implemented

English | [中文](2026-07-26-ci-failover-runbook.zh.md)

## Problem

The three required Linux worker jobs in [CI](../../../../.github/workflows/ci.yml) (`node 24 / static`, `node 24 / coverage`, `node 24 / snapshots and artifacts`), the required verdict job that aggregates them (`all checks passed`), and the independent native Windows evidence jobs run on standard GitHub-hosted runners by default. The [standard-hosted primary decision](2026-08-18-standard-hosted-primary-ci.md) owns those selectors and their worker limits. When a platform's hosted pool degrades, every matching pull request can remain unmergeable behind checks that cannot run. **Scope: two independent switches, one per platform.** `DSH_CI_FAILOVER_LINUX` recovers a hosted Linux-pool outage (the three required Linux workers plus the `all checks passed` verdict); `DSH_CI_FAILOVER_WINDOWS` recovers a hosted Windows-pool outage (the native Windows partitions). A Linux-pool outage need not retarget the native Windows jobs and vice versa. The verdict's other required dependencies (`node-compat`, `python-sdk`, `windows`) stay on standard hosted runners by design; in a broader GitHub-hosted capacity failure these dependencies still block `all checks passed`. An outage therefore needs a switch any responder with repository write access can throw without merging anything.

## Decision

Each of the three required Linux worker jobs, the independent native Windows jobs, and the `all checks passed` verdict job — which would otherwise stay queued on the failed pool even after every worker passed — resolves its runner pool through a repository variable, and the switch is split by platform so an outage on one platform does not retarget the other. The three Linux workers and the `all checks passed` verdict resolve through `DSH_CI_FAILOVER_LINUX`; the native Windows partitions resolve through `DSH_CI_FAILOVER_WINDOWS`. Unset (normal), they run on `ubuntu-latest` or `windows-latest`. Set to `selfhosted` by any repository writer, the corresponding jobs retarget onto the in-house pool. Each switch is writer-manageable repository state, not a merge, so it works while every check is red. The in-house pools run bounded Linux and Windows standby smokes on every master push and complete unsharded inventories daily or through the `standby-exhaustive` dispatch; the [tiered readiness decision](2026-08-24-tiered-standby-readiness.md) owns that evidence.

`ci-master.yml` sets `PNPM_CONFIG_OPTIONAL=true` for every job, deletes ignored and untracked checkout state, and runs the standby installs with `--force`. The persistent runners retain only content-addressed dependency downloads and controlled machine tools; each drill rebuilds `node_modules` and workspace outputs under repository-owned settings.

`ci-master.yml` exempts exactly one event from `cancel-in-progress` (`${{ github.event_name != 'push' }}`), so one master push does not cancel the bounded readiness smoke still running from the previous one. Scheduled and manually dispatched work remains replaceable by a newer non-push run.

The exemption does not guarantee that every push finishes: GitHub retains only one pending entry per concurrency group, and a non-push run evaluates the expression to `true` and may replace an older scheduled or manual run. The next master push restores bounded smoke evidence, while the next daily schedule or explicit dispatch restores exhaustive evidence.

The decision belongs at workflow level because cancellation applies to the whole superseded run: a job-level `concurrency` group does not exempt its job. The negated form keeps re-dispatched benchmarks and exhaustive drills replaceable. A master push in `ci-master.yml` carries only `wine-apt-cache` and the two bounded smokes; `scripts/ci-workflow.spec.ts` pins that push-reachable set so a new job cannot quietly accumulate uncancelled runs.

### What the in-house pool is

`vm-backup`: one 64-core VM, six always-on systemd-managed runner instances. Its image must preinstall Playwright Chromium's Linux system packages; CI downloads the lockfile-selected browser but never runs `apt` on this persistent shared host. Before switching, check the latest `standby smoke / linux (self-hosted)` result and the latest `standby-linux-exhaustive` artifact.

#### Windows pool

`dsh-win-ci`: 32 always-on runner instances (scheduled tasks `GH-Runner-01`…`GH-Runner-32`) on the in-house Windows CI server (one 96-core / 580 GB machine). Labels: `[self-hosted, dsh-win-ci, windows]`. The image must preinstall Node 24, pnpm, Git (with Git Bash on `PATH`, i.e. `C:\Program Files\Git\bin` — the `bash` tool spawns `bash` by name), PowerShell 7, and enable Developer Mode for symlink support. Before switching, check the latest `standby smoke / windows (self-hosted)` result and the latest `standby-windows-exhaustive` artifact.

### Switch (any repository writer, ~1 minute, no merge)

The two switches are independent: flip only the one whose platform is degraded.

1. Repository **Settings → Secrets and variables → Actions → Variables → New repository variable**: name `DSH_CI_FAILOVER_LINUX` (Linux pool outage) or `DSH_CI_FAILOVER_WINDOWS` (Windows pool outage), value `selfhosted`.
2. Retrigger the required jobs so they re-resolve their pool. Jobs already **queued** for the hosted labels do not retarget and cannot be re-run in place, so for the documented indefinite-queue outage, cancel the stuck run and re-run all jobs, or push a new commit; "Re-run failed jobs" only helps once a job has actually failed rather than queued.
3. That is the entire switch. Under Linux failover the workflow also raises `DSH_SNAPSHOT_MAX_CONCURRENCY` from 8 to 12 and the other bounded worker settings, and skips hosted-path pnpm cache restores because the VM's persistent store serves warm installs. Coverage uses the same four single-worker instrumented partitions and two exempt workers on both Linux pools. Under Windows failover it raises the native job's exempt-coverage workers from 1 to 2, partition concurrency from 1 to 8, and publint workers from 1 to 8; instrumented coverage stays on eight single-worker partitions.

#**Dependabot exception.** Both switches' selectors deliberately exclude `dependabot[bot]`: under failover, Dependabot PRs stay queued for the hosted pool rather than executing dependency-supplied code on the persistent VMs. A Dependabot PR that remains queued during an outage is expected behavior, not a failed switch; it completes when the hosted pool recovers.

**Who can flip the variable.** GitHub's API lets any collaborator with write access manage repository variables, so each switch is writer-level, not strictly admin-only. In this repository's trust model that is not an escalation: the runner groups admit all workflows of this private, fork-disabled repository (a deliberate trade to make PR-ref failover possible at all), so any writer could already reach the VMs by pushing a branch workflow. The boundary against untrusted code is repository membership; the variables only route work for members.

## Capacity during failover

Six always-on instances absorb normal PR traffic; the pool's steady-state master load is one bounded Linux smoke, while exhaustive work runs daily or manually. If queues still build, register additional instances with an org registration token (org Settings → Actions → Runners → New runner). Clone an existing runner directory **excluding its identity files** — `rsync -a --exclude '.runner*' --exclude '.credentials*' --exclude '_diag' --exclude '_work' <src>/ <dst>/` (the globs also catch `.runner_migrated`/`.credentials_migrated`, which GitHub writes on migrated runners and which equally trigger the already-configured refusal) — then run `config.sh` (copying `.runner`/`.credentials` verbatim makes it refuse with "already configured"), and **start the listener**: `sudo ./svc.sh install ubuntu && sudo ./svc.sh start`. Registration alone leaves the runner offline; only a started service adds capacity. About a minute per instance.


### Switch back

Delete the `DSH_CI_FAILOVER_LINUX` or `DSH_CI_FAILOVER_WINDOWS` variable (or set it to anything other than `selfhosted`). New runs resolve back to the standard GitHub-hosted pools. Remove any extra instances that were registered during the incident.

### Trust boundary

The variables are writer-manageable repository state; a pull request event itself can neither set them nor read a different value into effect, and the selector expressions live in workflow definitions. Note that under failover, `pull_request` runs execute the PR merge ref's own workflow definition — the boundary against untrusted code is repository membership (private, forking disabled, Dependabot excluded by the selectors), not the variable. Note on runner-group policy: pinning the runner group to the master-ref workflow is **incompatible** with this failover — the five failover jobs are `pull_request` runs evaluated from PR merge refs, and a master-pinned group leaves them queued (observed live on 2026-07-27; the group was widened to all workflows of this repository to unblock the switch). A stricter runner-side policy therefore costs PR failover; the shipped posture accepts repository-scoped, all-workflow group access.

## Alternatives considered

**Merge a workflow change to switch pools.** Rejected because the outage that motivates the switch is exactly the state in which no PR can merge: the required checks are the ones failing. A repository variable is writer-manageable state that takes effect on re-run without a merge.

**Keep the self-hosted pool always in the required path.** Rejected because it trades hosted-pool availability for the in-house VM's, moving a single point of failure rather than adding a fallback. The variables keep the hosted pools primary and the self-hosted pools proven, one-action standbys; splitting them by platform means an outage on one platform does not retarget the other.

## Consequences

Recovering from a hosted-pool outage is flipping the affected platform's variable (any writer) plus a re-run, with no merge on the critical path. The cost is a second runner topology per platform to keep working: bounded smokes exercise it after every master push, daily/manual exhaustive drills retain complete evidence, and the snapshot-concurrency and cache-restore branches in `ci.yml` carry a `selfhosted` leg (Linux only) that must stay in step with the hosted leg. Splitting the switch by platform bounds each switch to one platform.
