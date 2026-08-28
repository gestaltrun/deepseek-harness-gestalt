# Agent Note: Root README maps the Gestalt product layer

Status: implemented

English | [中文](2026-08-28-root-readme-product-evidence.zh.md)

## Problem

The root README described Gestalt as a desktop and phone workspace but did not make its relationship to official DeepSeek Harness precise. Readers could not see which capabilities came from the DSH base, which product functions Gestalt added, which community plugins it integrated, or which work remained active or planned.

A short gallery also hid the breadth of completed product work. An exhaustive package inventory would have the opposite failure: it would duplicate generated catalogs and expose implementation structure instead of explaining the product.

## Decision

The root README presents Gestalt as the product layer on top of official DSH. Its direction has four parts: complete the installable product, keep DSH composition and entry points compatible, integrate reviewed community plugins, and preserve one durable authority across clients. The README treats upstream compatibility as ongoing repository work, not a claim that every developer-preview commit is interchangeable.

The English product name is **Gestalt**. The Chinese product name and IP character are **獭子哥**. The landing page stores and displays the approved character sheet. Existing package names, application identifiers, release tags, and historical references remain unchanged until a separately coordinated rename requires their migration.

A tracker-backed product map separates Gestalt additions into product domains. `DONE` requires a capability to be merged into `master`; it does not claim inclusion in the latest packaged release. `DOING` requires an active delivery pull request. `TODO` requires an open issue selected for the product roadmap. Each nonempty state links the pull request, issue, owning reference, or plugin catalog that supports it. The map covers product functions added around the DSH base rather than repeating the official DSH package and tool catalogs. It is the sole product-status inventory in the README; feature tours explain completed behavior without repeating delivery state.

Feature tours expand the map with accepted product recordings for Workbench and Better Sidebar, Side Chat, Schedule, AI Browser, Workspace Reference, Annotation, and Mobile Companion. Every embedded GIF comes from a merged change's real product path and uses an immutable repository object id. Provenance remains in the linked pull requests.

Installation steps stay short. The README links first-run procedures to the user guide, composition and lifecycle semantics to architecture and application references, external integrations to the plugin catalog, and contributor workflows to development documentation.

## Alternatives considered

**Describe Gestalt only as another DSH client.** Rejected because Desktop, Mobile, Workbench, distribution, acceptance, and community integration are a product layer, not one client implementation.

**List every package and tool.** Rejected because generated catalogs and source own exhaustive inventories. The product map groups user-facing Gestalt additions by outcome.

**Show only completed work.** Rejected because active product direction would remain invisible. Tracker-backed `DOING` and `TODO` states distinguish committed delivery from plans without presenting open work as shipped.

**Use mock screenshots or conceptual artwork.** Rejected because they cannot demonstrate current product behavior. Accepted product recordings provide concrete evidence without turning the README into a test report.

**Embed every available recording.** Rejected because repeated animations make the page slow and hide the main product domains. One representative recording or paired comparison per tour is sufficient.

## Consequences

Readers can see the official DSH base, the extra Gestalt product layer, current delivery, and planned work in one pass, then inspect real workflows by domain. The status map can become stale, so every README change that touches product scope verifies its issue and pull-request links against the live tracker. No second roadmap section repeats those states. Detailed runtime behavior, configuration, compatibility limits, and verification remain in their owning documents and pull requests.
