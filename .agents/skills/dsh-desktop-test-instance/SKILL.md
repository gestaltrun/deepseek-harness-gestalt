---
name: dsh-desktop-test-instance
description: "Start, replace, or clean one isolated Desktop test Electron. Use when the user asks to 启动测试程序, open a test Electron, prepare an acceptance instance, or clean leftover test processes, and when an agent-run Desktop instance needs a model call."
---

# Desktop test instance

Own one isolated Desktop Electron per user goal. Automated lanes such as `pnpm --dir apps/desktop test:e2e-sub2api` keep their own teardown; this skill covers agent-started instances the runner does not own.

## Steps

1. **Read the memo.** Open `.agents/local/runtime-memo.json` if it exists. Treat its `goal`, `desktop`, and `ego` records as the live inventory for this goal. Complete when the file is parsed or confirmed absent.

2. **Stop the recorded instance first.** If `desktop` names a live Electron, Web Host, PostgreSQL, sidecar, CDP port, scratch root, `DSH_HOME`, or user-data directory, stop those exact PIDs and then remove those exact paths. Kill by recorded PID and path only. Complete when `ps` / `lsof` show those PIDs and ports gone and the recorded directories are absent.

3. **Refuse a second instance.** Scan for other Desktop test processes that still belong to this goal (same scratch root, same memoed `DSH_HOME`, or the same ticket/PR Electron). Stop them before creating a replacement. Complete when this goal has zero live test Electron / Host / PostgreSQL / sidecar processes.

4. **Choose headed only for looking.** Agent self-test, bug reproduction, and pre-acceptance checks run headless. Start a visible window only when the user asks to look, click, or accept. Complete when the chosen mode is `headless` or `headed` and matches that rule.

5. **Create a fresh scratch and inherit the installed provider.** Make a new `0700` scratch root with `dsh-home` and `electron-user-data`. Blind-copy only `settings.yaml` and `.credentials.yaml` from the normal DSH Home, following `copyModelConfiguration` in `scripts/web-acceptance.ts`: regular files, no symlinks, target mode `0600`. Copy no session, workspace, browser, or Ego state. Do not invent provider models. If those two files are absent, stop and report the credential blocker. Complete when the scratch exists, the copied files are owner-only, and the instance will load that installed provider catalog.

6. **Start exactly one instance and write the memo.** Launch Desktop against that scratch `DSH_HOME` and user-data. Record every live PID, port, and directory in `.agents/local/runtime-memo.json` without secrets. Complete when one instance is up and the memo's `desktop` record matches it.

7. **Clear the memo on teardown.** After the user finishes, the HEAD changes, the run fails, or a replacement is required, stop the recorded processes, delete the scratch root, and remove or empty the `desktop` record. Complete when the next read of the memo cannot name a live instance.

## Display

| Request | Mode |
|---|---|
| Agent self-test, reproduce, fix, re-run before acceptance | `headless` |
| User asks to look, click, or accept | `headed` after the same cleanup |

Headed and headless both use the scratch home. Never point a test instance at the user's normal `DSH_HOME`.

## Model provider

A test instance that calls a model uses the provider catalog already stored in the normal DSH Home. The copy in step 5 is that catalog. Do not add fallback models, edit `route.models`, or point the instance at a fixture provider unless the user names that substitute.

Print no secret values. Record only provider and model reference names in logs, memos, and pull-request text.

## Runtime memo

`.agents/local/runtime-memo.json` is gitignored local state for this checkout. One file serves Desktop instances and the ego-browser task space for the same goal.

```json
{
  "goal": "445-sub2api",
  "desktop": {
    "mode": "headless",
    "pid": 12345,
    "hostPid": 12346,
    "postgresPids": [12347],
    "cdpPort": 9222,
    "scratchRoot": "/tmp/dsh-desktop-445",
    "dshHome": "/tmp/dsh-desktop-445/dsh-home",
    "userData": "/tmp/dsh-desktop-445/electron-user-data"
  },
  "ego": {
    "profile": "DSH",
    "taskSpaceId": 12,
    "taskSpaceName": "445-sub2api"
  }
}
```

Write only identifiers and paths. If the memo names a process or space that no longer exists, delete that record and continue from a clean inventory.

## Cleanup

Stop recorded PIDs, then verify. Do not use a command-line substring kill that can match the shell running the cleanup. After stop, confirm:

- the Electron, Web Host, PostgreSQL, and sidecar PIDs are gone;
- the CDP port is closed;
- the scratch root, `DSH_HOME`, and user-data directories are gone;
- on macOS, PostgreSQL SysV shared-memory segments whose `CPID`/`LPID` match the recorded PIDs are gone.

The Sub2API Electron runner already fails if those survivors remain; agent-started instances use the same completion bar.

GIF recording still follows [record-browser-gif](../record-browser-gif/SKILL.md). Browser automation still follows [ego-browser](../ego-browser/SKILL.md), which reads and writes the `ego` record in this memo.
