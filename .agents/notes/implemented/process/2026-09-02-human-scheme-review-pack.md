# Agent Note: Human scheme review pack is not an Agent Note

Status: implemented

English | [中文](2026-09-02-human-scheme-review-pack.zh.md)

## Problem

A technical scheme needs two readers. Agents later implementing or reviewing code need a durable proposed Agent Note: exact module names, seams, failures, and alternatives. A human asked to approve the scheme needs a short, pictured explanation. Using the Note as the review document forces Agent Note prose onto the human, or forces unslopped voice into the durable record.

## Decision

[`codebase-design/SCHEME.md`](../../../skills/codebase-design/SCHEME.md) splits the artifacts. The proposed Agent Note lives on the planning branch under `.agents/notes/proposed/` and stays contract prose under [dsh-prose-standard](../../../skills/dsh-prose-standard/SKILL.md). The human review pack is one HTML file under gitignored `.agents/local/scheme-review/<slug>/`. That pack is composed with eli5 (big pictures, few words), [show-me](../../../skills/show-me/SKILL.md) (one focused diagram), and [unslop](../../../skills/unslop/SKILL.md) (voice-led human prose). It is disposable. It is not committed. It is not a second Note.

The scheme session is isolated from the coordinating grill. The agent self-checks the Note before building the pack, then opens the HTML for the human. Freeze leaves the Note in `proposed/` until an implementation PR rewrites it to `implemented/`.

The [eli5](https://github.com/anthropics/claude-plugins-community/tree/main/eli5/skills/eli5) community skill is Apache-2.0. This repository does not vendor it; SCHEME.md describes the same "big pictures, few words" presentation without copying that skill tree. `show-me` and `unslop` remain the pinned MIT copies already in `.agents/skills`.

## Alternatives considered

**Use the proposed Agent Note as the human review.** The Note must stay exact for later agents. Unslopping it would strip the contract voice the implementation review needs.

**Commit the HTML pack next to the Note.** Review materials go stale the moment the Note changes, and they bloat history with one-off pictures. `.agents/local/` already holds disposable checkout state.

**Vendor the Apache-2.0 eli5 skill into `.agents/skills`.** The third-party notices generator requires MIT License files for copied repository skills. Teaching the presentation in SCHEME.md avoids a second license class in that table.

**Open a headed Desktop instance to present the scheme.** The pack is a static HTML file. Desktop test instances are for product UI, not for reading a scheme.

## Consequences

Humans can approve a scheme without reading Agent Note headings. Later tickets and `dsh-code-review` still read the Note. Lost local packs do not lose the decision; the Note remains. A reviewer who wants more detail follows the link in the pack.
