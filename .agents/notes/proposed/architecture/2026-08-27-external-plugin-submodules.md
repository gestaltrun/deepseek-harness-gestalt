# Agent Note: Pin out-of-tree Gestalt plugins as Git submodules

Status: proposed

English | [中文](2026-08-27-external-plugin-submodules.zh.md)

## Problem

Gestalt develops installable DeepSeek Harness plugins in their own GitHub repositories so each plugin can version, release, and carry native runtime packs independently of the Desktop Bundle. Contributors still need a durable in-repo pointer to the exact revision Gestalt currently develops against, without copying that source into `packages/` or treating Docker as the Desktop install path.

A floating URL in conversation, an undocumented clone beside the checkout, or a git subtree that rewrites foreign history into this repository all lose that pointer: clones disagree, `packages/` gates start owning foreign code, and Desktop packaging cannot tell a source pin from an install payload.

## Proposal

Add a top-level `plugins/` catalog of Git submodules. Each child is one out-of-tree plugin repository. The recorded submodule SHA is the pin. `plugins/README.md` is the catalog contract.

The first child is [`gestaltrun/dsh-sub2api-sidecar`](https://github.com/gestaltrun/dsh-sub2api-sidecar) at `plugins/dsh-sub2api-sidecar`. That plugin remains a separate product: it supervises a local Sub2API process, issues an `admin-` key for Host-side admin HTTP and an `sk-` key for Composite inference, and registers the Composite endpoint through `dsh-llm-pi-ai`. Gestalt Desktop later shows an Offer card and downloads a built bundle plus a platform runtime pack on enablement. The submodule does not become that payload and does not join `pnpm-workspace.yaml`.

`vendor/` stays the in-tree Cordis source. `packages/` stays `@deepseek-ai/dsh-*` workspaces. A plugin that Gestalt later ships as a first-party harness package still moves into `packages/`.

Default `git clone` leaves catalog children empty until `git submodule update --init --recursive`. CI jobs that need plugin source set `submodules: recursive` on `actions/checkout`. Jobs that only need harness source leave the default empty checkout.

## Alternatives considered

**Git subtree.** A subtree copies the plugin history into this repository and makes `git log` and `git blame` mix two products. Updates become subtree merge commits instead of a one-line SHA move. The plugin cannot keep an independent GitHub default branch as the source of truth.

**A path-only README that names GitHub URLs.** Clones do not fetch the plugin, CI cannot reproduce the pin, and the recorded revision lives only in prose.

**Vendoring the plugin under `vendor/` or `packages/`.** `vendor/` is the Cordis framework layer with a rescope and local-modification log. `packages/` is the pnpm workspace that CI typechecks, covers, and publishes. The sidecar's Go runtime, Postgres, and Redis packs must not enter those gates.

**npm `file:` or git dependency from a Gestalt package.json.** That couples install of every Desktop developer to the plugin workspace and still does not give a browsable in-repo checkout for agents that need the plugin source beside the harness.

**Docker Compose as the Desktop default.** Gestalt ships Electron plus bundled Node. Requiring Docker Desktop is a second product install, not an enablement download.

## Acceptance criteria

- `plugins/` exists, documents the catalog, and records `dsh-sub2api-sidecar` as a submodule of `https://github.com/gestaltrun/dsh-sub2api-sidecar.git`.
- A fresh clone without `--recurse-submodules` remains a valid harness checkout; initializing the submodule checks out the recorded SHA.
- `pnpm-workspace.yaml` and TypeScript project references do not include catalog children.
- The Agent Note names the two Sub2API credentials (`admin-` for admin HTTP, `sk-` for Composite inference) so later Desktop work does not collapse them into one token.

## Risks

A contributor who forgets `git submodule update` sees an empty directory and may treat the catalog as missing. The README states the init command. CI that later typechecks plugin source must opt into recursive checkout; silent empty directories would hide that miss.

Submodule pins lag the plugin default branch until a Gestalt commit moves them. That lag is the point of a pin: Desktop and agents reproduce one SHA, not `main` HEAD.
