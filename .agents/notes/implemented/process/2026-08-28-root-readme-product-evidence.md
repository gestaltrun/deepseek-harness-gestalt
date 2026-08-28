# Agent Note: Root README maps the Gestalt product layer

Status: implemented

English | [中文](2026-08-28-root-readme-product-evidence.zh.md)

## Problem

The root README described Gestalt as a desktop and phone workspace but did not make its relationship to official DeepSeek Harness precise. Readers could not see which capabilities came from the DSH base, which product functions Gestalt added, which community plugins it integrated, or which work remained active or planned.

A short gallery also hid the breadth of completed product work. An exhaustive package inventory would have the opposite failure: it would duplicate generated catalogs and expose implementation structure instead of explaining the product.

## Decision

The root README presents Gestalt as the product layer on top of official DSH. Its direction has four parts: complete the installable product, keep DSH composition and entry points compatible, integrate reviewed community plugins, and preserve one durable authority across clients. The README treats upstream compatibility as ongoing repository work, not a claim that every developer-preview commit is interchangeable.

The English product name is **Gestalt**. The Chinese product name and IP character are **獭子哥**. The landing page stores and displays the approved character sheet. Existing package names, application identifiers, release tags, and historical references remain unchanged until a separately coordinated rename requires their migration.

A product architecture diagram separates the official DSH foundation, Gestalt's shared product layer, and the user-facing product areas. `DONE` requires a capability to be merged into `master`; it does not claim inclusion in the latest packaged release. `DOING` requires active delivery. `TODO` requires an open issue selected for the product plan. The map covers product functions added around the DSH base rather than repeating the official DSH package and tool catalogs.

One vertical table is the README's product-status inventory and feature tour. Each row names a product area, its completion, concrete user functions, and at most one product recording. Completed functions link their owning product documentation instead of a delivery ledger; planned functions link the tracker item that defines their direction. Recordings cover Workbench and Better Sidebar, Side Chat, Schedule, AI Browser, Workspace Reference, Annotation, and Mobile Companion. Every embedded GIF uses an immutable repository object id.

Installation steps stay short. The README links first-run procedures to the user guide, composition and lifecycle semantics to architecture and application references, external integrations to the plugin catalog, and contributor workflows to development documentation.

## Alternatives considered

**Describe Gestalt only as another DSH client.** Rejected because Desktop, Mobile, Workbench, distribution, acceptance, and community integration are a product layer, not one client implementation.

**List every package and tool.** Rejected because generated catalogs and source own exhaustive inventories. The product map groups user-facing Gestalt additions by outcome.

**Show only completed work.** Rejected because active product direction would remain invisible. Tracker-backed `DOING` and `TODO` states distinguish committed delivery from plans without presenting open work as shipped.

**Use mock screenshots or conceptual artwork.** Rejected because they do not show the product a user can run. Product recordings show the current workflows.

**Place recordings side by side.** Rejected because wide rows dominate the page and become cramped on narrow screens. The table places one recording on each row and keeps the walkthrough vertical.

## Consequences

Readers can see the official DSH base, the shared Gestalt product layer, product areas, completion, and concrete functions in one pass. The status table can become stale, so every README change that touches product scope checks active and planned items against the live tracker. No second roadmap or feature gallery repeats the table. Detailed runtime behavior, configuration, compatibility limits, and verification remain in their owning documents and pull requests.
