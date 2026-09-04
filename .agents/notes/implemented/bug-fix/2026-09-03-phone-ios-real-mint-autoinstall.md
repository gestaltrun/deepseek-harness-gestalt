# Agent Note: Install the iOS real-device agent during Host mint

Status: implemented

English | [中文](2026-09-03-phone-ios-real-mint-autoinstall.zh.md)

## Problem

Opening an online iOS real-device panel mints `POST /phone/session` first. When `agentStatus.installed` is false, Host answered `409 PHONE_AGENT_MISSING` without `installAgent`. GUI `PhoneConnectionController.recoverAgent` runs only after that error phase, so a recoverable missing agent blocked the picture even though `device_act` already succeeded on the same handset.

## Decision

Host mint owns the first recoverable install. For a listed iOS real device, `POST /phone/session` runs `agentStatus`; when the agent is absent it calls idempotent `installAgent` without `force`, re-checks status, and mints the picture session. `PHONE_AGENT_MISSING` remains only when that install still leaves the agent absent. Thrown install failures keep their existing Host mapping: `PHONE_AGENT_PROFILE_REQUIRED` (including a Host that has no `provisioningProfilePath`), `PHONE_REAL_DEVICE_ISSUE` arms, and `INSTALL_FAILED_USER_RESTRICTED` via `PHONE_UPSTREAM`. iOS Simulator mint stays agent-not-managed and never installs. `recoverAgent` stays the GUI path for leftover missing, force-reinstall, and restricted failures.

## Alternatives considered

**Install from the GUI error card only.** Rejected: opening the panel always mints first, so `PHONE_AGENT_MISSING` remains the first user-visible failure even when recovery is possible.

**Always `force` reinstall on mint.** Rejected: mint must be idempotent for an already-installed agent; force-reinstall is an explicit recovery action.

**Skip install when `provisioningProfilePath` is unset.** Rejected: a missing profile is `PHONE_AGENT_PROFILE_REQUIRED`, not a silent skip.

**Install on iOS Simulator mint.** Rejected: simulator agent operations stay `agent-not-managed`; preparation already owns simulator agent install.

## Consequences

Any trusted mint caller, not only the GUI, gets a recoverable missing-agent install. Unrecoverable failures stay structured and do not mint. Opening a real-device panel can wait on `agentTimeoutMs` while install runs. Package tests pin missing → install → 200 session, install-failure codes, leftover `PHONE_AGENT_MISSING`, and unchanged simulator mint.
