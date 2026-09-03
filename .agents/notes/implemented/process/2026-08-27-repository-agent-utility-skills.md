# Agent Note: Repository agent utility skills

Status: implemented

English | [中文](2026-08-27-repository-agent-utility-skills.zh.md)

## Problem

Repository agents need shared workflows for visual explanations, skill assessment, retrospectives, prose cleanup, and browser operation. Personal skill installations do not give every repository checkout the same instructions. Browser automation also needs a stable account choice: ego task spaces inherit login state from a user profile, while profile ids and the current default can change independently of this repository.

## Decision

The repository stores `show-me`, `skill-doctor`, `retro`, `implement-spec`, `unslop`, `ego-browser`, and `dsh-desktop-test-instance` under `.agents/skills`. These are repository agent workflows; they do not add DeepSeek Harness runtime packages or change a shipped bundle. [`.agents/skills/SOURCES.json`](../../../skills/SOURCES.json) pins each vendored source and records local adaptations, while each vendored Skill directory preserves its upstream MIT notice. The generated [third-party notices](../../../../THIRD_PARTY_NOTICES.md) disclose the same records.

The repository copy of `ego-browser` requires the ego profile named `DSH`. Its helpers resolve that profile through `listProfiles()` before creation, reuse, claim, takeover, or completion; pass the returned id to `globalThis.ego.createTaskSpace(name, profileId)` for creation; and reject an existing matching task space owned by another profile. The helpers fail when the profile name is absent or ambiguous. One user goal reuses one DSH task space through the gitignored [runtime memo](2026-09-02-desktop-test-instance-and-runtime-memo.md). Installation remains a user-operated download and macOS trust flow; the Skill does not download installers, replace applications, remove quarantine metadata, or invoke an installer as root.

Generated interpreter caches and local skill reports remain outside version control. `skill-doctor` renders proposed diffs with self-contained HTML instead of committing a third-party JavaScript bundle.

## Verification

Repository skill metadata and documentation checks cover the installed files. A real ego runtime check creates a temporary task space, verifies `profileName` is `DSH`, and removes the space after the assertion. A negative runtime check creates a temporary space under another profile and verifies the DSH resolver rejects it before claim or takeover.

## Alternatives considered

**Install the skills only in each agent's home directory.** This leaves repository behavior dependent on one machine's configuration and gives changes no repository review path.

**Use ego's current default profile.** The GUI default is mutable and can select an account unrelated to this repository.

**Store the current `Profile 2` id.** Ego may assign a different id after profile changes or on another machine. Resolving the unique `DSH` name retains the intended account without treating a local identifier as configuration.

**Keep the bundled diff renderer.** The bundle adds an opaque dependency closure and license burden to a repository workflow. Native escaped HTML retains local, self-contained reports without that copied runtime.

## Consequences

Agents operating in this repository receive the same shared workflows. Browser work stops with a profile configuration error instead of silently using another account. Upstream Skill updates must refresh `SOURCES.json`, retain the license, and preserve or deliberately revise repository adaptations.
