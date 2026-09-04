# Agent Note: Repair File/Session Reference CI reds

Status: implemented

English | [中文](2026-08-21-file-session-ci-reds.zh.md)

## Problem

The File/Session Reference sync against official Host `@path` / `file-reference-local` plus `session-reference` left four merge-blocking reds on Gestalt `#204`. Linux coverage reported a pwsh backend that treated the echoed `PWSH_PROMPT_SETUP` source as the installed `dsh> ` prompt, so `tool-pwsh-persistent` later extracted no command marker and the relay first-frame test closed an oversized frame with `1008` instead of `1009`. The consumers lane failed publint on a hashed `remote-access-client` chunk, Web settings goldens that still listed the deleted Workspace-reference nav item, and Composer image-pin e2e that opened a preview with no `Annotate image` control. Refreshing the persistent-pwsh snapshot to clipped bootstrap, or widening the package `files` list for hashed chunks, would hide those failures.

## Decision

**pwsh spawn waits until the last line is the default `PS …>` prompt, then submits LF on Unix and CR on Windows, and waits for a split `Write-Output` done token, not a reprinted `dsh> `.** Restoring the official Host string `'dsh> '` inside `PWSH_PROMPT_SETUP` made Linux coverage and the ACP `persistent-pwsh-tool-turn` snapshot red again: the PTY echoes that source before the function runs, spawn returns, and the next write concatenates. Last-line / contiguous ready-probe / `-NoExit -Command` checks also failed: Linux often does not reprint a last-line `dsh> `, a probe that appears in the source is the same false-ready, and `-Command` dumped binary into the PTY. Looping until `includes('dsh> ')` timed out (`32456229621`) because that text never reprints after the source split. Treating one empty follow-up as ready (`32457685533`) published an empty motd, left the loader on the default `PS>` prompt, and timed the first command out. Waiting for `__DSH_PWSH_SETUP_DONE__` with lone-CR submit then timed out (`32459139618`): Linux PSReadLine treats CR as cursor-home, so the setup line echoed and never ran. Submitting CRLF still timed out (`32460394471`): CR still homes first, so the line still does not run. Submitting LF immediately still timed out (`32462089006`): scrollback was the setup source plus the first `PS /tmp/…>` prompt, so the write landed during banner and never ran. Calling `initialize` then writing setup got `session_exit` (`32463876213`): stdin-wait can settle at 150 ms before that prompt owns the TTY. A last-line-only `PS …>` check then timed out with the prompt already in scrollback (`32465320155`): Linux PSReadLine leaves reverse-video CSI around the path. Matching after SGR strip and writing on the first stdin_wait then dumped binary after the prompt (`32466566587`). Requiring `inferred_idle` never wrote (`32467952709`). Waiting `idleSilenceMs` after the prompt still left only `PS /tmp/…>` (`32469299678`). `-NoExit -File` printed the token but later sends were empty or aborted (`32470697182`). Deleting the isolated HOME at spawn return also dropped later sends (`32472737736`). Keeping that home until close still left later sends empty or aborted (`32474124270`). `PSConsoleHostReadLine` (`32479597008`) and a stub PSReadLine module (`32480892916`) both dumped UTF-16 `Stop` / PerfTrack text and hid the token. The isolated profile therefore runs a stdin `ReadLine` loop whose `finally` exits the process after `exit`, keeps that home until session close, and waits for the token plus `dsh> `. Later submits still use LF on Unix and CR on Windows. The setup concatenates the prompt and `__DSH_PWSH_SETUP_DONE__` at runtime, then loops follow-ups until viewport or scrollback `includes` the assembled token. The tool layer waits for `__DSH_PWSH_TOOL_SETUP_DONE__` the same way. `session_exit`, a per-send `timeout`, and spawn-wall `timeoutMs` still reject. Official inferred-idle still has no extra last-line gate. The [persistent pwsh note](../architecture/2026-08-11-pwsh-persistent-pty.md) still owns the two-layer prompt install.

**Relay payload-size uses the default first-frame deadline.** The idle-timeout assertion still starts a 10 ms server. The oversized-frame assertion starts a separate server at the default 1000 ms so attach-timeout cannot pre-empt the 1009 close.

**`remote-access-client` emits one file per entry.** Each published file is its own tsdown face with `outputOptions.codeSplitting: false`, matching compaction and the JSON-RPC demo. A multi-entry face cannot disable splitting. The package `files` whitelist and `packageFileExtras` stay unchanged.

**Settings goldens drop the deleted Workspace-reference row.** The nav item is absent after `ui-workspace-reference` was removed; the expected trees no longer include `工作区引用`.

**Composer previews restore the official pin overlay, and InputBar keeps the Gestalt annotation chip.** `InputBar` passes `useComposerImagePinOverlay` through `pinOverlayFor`. `ComposerAttachments` owns pin-mode state and sets `annotation.gifRefuse` only when the user toggles annotate on `image/gif`. Opening a preview does not show that alert. History pins keep `source: 'history'`; Composer pins keep the default `composer` source. The two overlay hooks share `useImagePinOverlay` so jscpd does not treat the Composer restore as a clone of the history hook. Taking official `InputBar` dropped the `{count} annotation` summary and discard control the Web e2e uses; the chip, per-item edit/delete, and annotation-only send enablement stay on the composer card. A parent-offline continuable child keeps input locked and primary Stop enabled. Empty-draft steering retries Playwright `fill` plus `Enter` on the visible InputBar textarea — a leftover hidden node also carries `data-phase` — until each queued row appears.

## Alternatives considered

**Embed `dsh> ` in `PWSH_PROMPT_SETUP` and treat `includes` as official Host does.** Rejected: a Linux PTY echoes that source before the function runs, so spawn returns and the next write concatenates.

**Loop empty follow-ups until viewport or scrollback `includes` the installed prompt.** Rejected: after the source split, a Linux PTY never reprints `dsh> `, so the loop hits `timeoutMs` (coverage run `32456229621`).

**Treat one empty follow-up as readiness when the installed prompt is absent.** Rejected: spawn published with an empty motd; the loader stayed on `PS>` and the first command timed out (coverage run `32457685533`).

**Wait for the split done token while still submitting a lone CR.** Rejected: Linux PSReadLine never executed the setup line, so the token never appeared (coverage run `32459139618`).

**Submit pwsh lines with CRLF.** Rejected: coverage run `32460394471` still timed spawn out at 15 s; CR still homes the cursor before LF, so the setup line still does not run.

**Submit LF immediately after spawn.** Rejected: coverage run `32462089006` printed the setup source then the first `PS /tmp/…>` prompt with no token; the write landed during banner and never executed.

**Call `initialize` then write setup.** Rejected: coverage run `32463876213` exited during the setup send; stdin-wait can settle at 150 ms before the default prompt owns the TTY.

**Match only an exact last-line `PS …>` without stripping SGR.** Rejected: coverage run `32465320155` timed out with `PS /tmp/…>` already in scrollback; Linux PSReadLine wraps the path in reverse-video CSI.

**Write setup on the first send that sees a `PS …>` line.** Rejected: coverage run `32466566587` wrote during reverse-video draw; viewport after the prompt was binary and the token never appeared.

**Wait for an `inferred_idle` waitReason before writing setup.** Rejected: coverage run `32467952709` never wrote; with `acceptsStdinWait`, every send settles on `stdin_wait` at `exactProbeAfterMs`.

**Hold `idleSilenceMs` after the default prompt, then write setup through the session.** Rejected: coverage run `32469299678` timed out with only `PS /tmp/…>` in viewport and scrollback; the token never appeared.

**Put the prompt function on `-NoExit -Command` in argv.** Rejected: UTF-16/binary MOTD and no `keep=ok`.

**Install the prompt with `-NoExit -File` before PSReadLine starts.** Rejected: coverage run `32470697182` printed the token, then later sends were empty (`keep=ok`) or `PTY send aborted before write`.

**Delete the isolated HOME when spawn returns.** Rejected: coverage run `32472737736` printed the token, then later sends were empty (`keep=ok`) and the tool said the shell did not accept initialization.

**Keep the isolated HOME until session close and still use PSReadLine.** Rejected: coverage run `32474124270` printed the token, then later sends were empty (`keep=ok`) or `PTY send aborted before write`, and the tool said the shell did not accept initialization.

**`Remove-Module PSReadLine` in the isolated profile.** Rejected: coverage run `32479597008` printed `dsh> ` then UTF-16 `Stop:Powershell` / PerfTrack text; spawn timed out waiting for the token, and a later command echoed into the same dump.

**Define `PSConsoleHostReadLine` or shadow PSReadLine with an empty 9.9.9 module.** Rejected: coverage run `32480892916` produced the same UTF-16 `Stop` / PerfTrack dump without `Remove-Module`.

**Require last-line `dsh> `, a `__DSH_PWSH_READY__` probe, or `pwsh -NoExit -Command` prompt install.** Rejected: Linux often never reprints a last-line prompt, a probe that appears in the source is the same false-ready, and `-Command` writes binary into the PTY.

**Refresh `persistent-pwsh-tool-turn` to the clipped bootstrap transcript.** Rejected: that records the false-ready failure as success. The tool must still extract `PWSH_OK` after a real second prompt install.

**Add hashed `lib/relay-*.js` names to `files`.** Rejected: `check-workspace-constraints` generates the expected file list. A split chunk is an emit defect, not a packaging exception.

**Set `codeSplitting: false` on the three-entry browser face.** Rejected: tsdown refuses multiple inputs when splitting is off. Each published file is its own face.

**Keep first-frame and payload-size on one 10 ms server.** Rejected: under coverage-partition load the attach deadline wins and closes 1008 before the size check.

**Leave the Workspace-reference golden rows and close the settings dialog between cases.** Rejected: the product nav no longer has that row. Shared-page overlay failures were a symptom of the stale first golden.

**Show the GIF refuse alert as soon as the preview opens.** Rejected: the annotate control is the refuse moment. A PNG preview must not show an alert.

**Wrap the mirrored pin hooks in `jscpd:ignore`.** Rejected: the overlay construction is one function. Ignore comments would hide a real clone.

## Consequences

Official File/Session Reference stays the only `@` file source. Persistent pwsh waits until the last line is the default `PS …>` prompt, submits LF on Unix and CR on Windows, and waits for split `Write-Output` tokens, so Linux coverage and the ACP pwsh snapshot extract `PWSH_OK` after both functions run, without waiting for a reprinted `dsh> `. Relay, publint, settings goldens, Composer pin e2e, and the annotation-count chip exercise the repaired paths. The deleted Workspace-reference picker goldens stay deleted.

## Testing

`packages/terminal/terminal-bash/tests/session.spec.ts` pins that a pwsh submit writes LF on Unix and CR on Windows, and a bash submit still writes CR. `packages/terminal/terminal-bash/tests/index.spec.ts` pins that pwsh spawn strips `-NoProfile`, points `HOME` at an isolated profile that runs the stdin `ReadLine` loop, waits for the done token and `dsh> `, and keeps that home until session close, that `PWSH_PROMPT_SETUP` contains neither `dsh> ` nor `__DSH_PWSH_SETUP_DONE__`, that a source-only first send keeps waiting, and that a spawn whose echo never prints the token hits `timeoutMs`. `local.spec.ts` requires that token in motd and `keep=ok` after a real pwsh spawn when `pwsh` is on PATH. `packages/shell/tool-pwsh-persistent/tests/tools.spec.ts` waits past a setup-source echo for `__DSH_PWSH_TOOL_SETUP_DONE__`. `packages/client/ui-attachment/tests/message-image.client.spec.tsx` covers history pin overlay, refuse, and place. Empty-draft steering queues the first row, then sends the second draft on the same visible InputBar immediately so both attach before the question composer replaces the textarea, then flushes with Cmd+Enter. The steer-all mid golden keeps the same `Ask question waiting` tool row as the sibling steering mid golden. `packages/platform/remote-access-http/tests/relay.spec.ts` still closes idle at 1008 and oversized at 1009 on separate servers. `packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx` and `packages/client/ui-conversation/tests/composer-image-pins.client.spec.tsx` cover annotate, GIF refuse-on-toggle, and the composer overlay factory. `pnpm run duplication` owns the shared `useImagePinOverlay` extraction. `packages/client/ui-conversation/tests/input-bar.client.spec.tsx` covers the annotation-count chip, discard, per-kind delete, and in-flight lock. Web settings goldens no longer list `工作区引用`. `pnpm exec tsx scripts/gen-client-catalog.ts --check` owns the `ComposerAttachmentsOwnerProps.pinOverlayFor` catalog text.
