# Agent Note: Repository agent utility skills

Status: implemented

English | [中文](2026-08-27-repository-agent-utility-skills.zh.md)

## Problem

Repository agents need shared workflows for visual explanations, skill assessment, retrospectives, prose cleanup, and browser operation. Personal skill installations do not give every repository checkout the same instructions. Browser automation also needs a stable account choice: ego task spaces inherit login state from a user profile, while profile ids and the current default can change independently of this repository.

## Decision

The repository stores `show-me`, `skill-doctor`, `retro`, `unslop`, and `ego-browser` under `.agents/skills`. These are repository agent workflows; they do not add DeepSeek Harness runtime packages or change a shipped bundle.

The repository copy of `ego-browser` requires the ego profile named `DSH`. Its task-space helper resolves that profile through `listProfiles()` for each operation, passes the returned id to `globalThis.ego.createTaskSpace(name, profileId)`, and rejects an existing matching task space owned by another profile. The helper fails when the profile name is absent or ambiguous.

Generated interpreter caches and local skill reports remain outside version control. The bundled `pierre-diffs.js` renderer retains literal whitespace in template strings, so its path disables Git's `blank-at-eol` check without weakening whitespace checks for other files.

## Verification

Repository skill metadata and documentation checks cover the installed files. A real ego runtime check creates a temporary task space, verifies `profileName` is `DSH`, and removes the space after the assertion.

## Alternatives considered

**Install the skills only in each agent's home directory.** This leaves repository behavior dependent on one machine's configuration and gives changes no repository review path.

**Use ego's current default profile.** The GUI default is mutable and can select an account unrelated to this repository.

**Store the current `Profile 2` id.** Ego may assign a different id after profile changes or on another machine. Resolving the unique `DSH` name retains the intended account without treating a local identifier as configuration.

## Consequences

Agents operating in this repository receive the same five workflows. Browser work stops with a profile configuration error instead of silently using another account. Updates from the upstream ego skill must preserve or deliberately revise the repository-specific `DSH` policy.
