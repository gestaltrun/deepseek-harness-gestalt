# Agent Note: Root README leads with product evidence

Status: implemented

English | [中文](2026-08-28-root-readme-product-evidence.zh.md)

## Problem

The root README began with a short Desktop and phone description, then moved directly into run commands. It did not explain why durable Sessions, plugin composition, or several clients belong in one product. Readers could not distinguish the repository's product direction from its installation surface, and the page did not show completed product behavior already demonstrated through exact-product acceptance recordings.

The architecture reference owns internal composition and the user guides own procedures. Copying either into the README would make the landing page long and create a second home for facts that change with the runtime.

## Decision

The root README is the product landing page for DeepSeek Gestalt and DeepSeek Harness. It introduces the vision first: one durable Session connects models, tools, files, human decisions, and clients, while plugins keep capabilities replaceable. It then shows a small set of current user workflows before listing built capabilities and the shortest supported run paths.

Each embedded product GIF comes from a merged change's accepted product path and uses an immutable repository object id in its URL. The selected set covers the repository Workbench, durable Side Chat continuation, and encrypted Mobile Companion continuation. The README states only the behavior visible in the current product or owned by the linked architecture and user references; detailed provenance remains in merged pull requests [#317](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/317), [#329](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/329), and [#312](https://github.com/gestaltrun/deepseek-harness-gestalt/pull/312), respectively.

Installation steps stay short. The README links to the user guide for first-run detail, architecture for composition and lifecycle semantics, generated catalogs for current runtime interfaces, and development documentation for contributor workflows. Community and legal information remain available after the product and run sections.

## Alternatives considered

**Keep the command-first README.** Rejected because installation alone does not explain the product or show why its Desktop, Web, Mobile, Session, and plugin work belongs together.

**List every package and feature.** Rejected because source and generated catalogs already own exhaustive inventories, and a hand-maintained list would drift.

**Use mock screenshots or conceptual artwork.** Rejected because they cannot demonstrate current product behavior. Accepted product recordings provide concrete evidence without turning the README into a test report.

**Embed every available product GIF.** Rejected because repeated animations make the page slow and obscure the three workflows that explain the product direction.

## Consequences

New readers can understand the product before choosing an installation path and can inspect real workflows without leaving the page. The README is longer and downloads three small GIFs, so maintainers keep the set limited and replace an asset only with another accepted product recording. Detailed behavior, configuration, and verification continue to live in their owning documents and pull requests.
