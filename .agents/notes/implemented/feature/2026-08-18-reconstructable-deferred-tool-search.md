# Agent Note: Reconstructable deferred tool search

Status: implemented

English | [中文](2026-08-18-reconstructable-deferred-tool-search.zh.md)

## Problem

Large dynamic tool catalogs spend request tokens before the model knows which capability it needs. Omitting schemas reduces that cost, but an execution-local search result would make the next request depend on transient registry state and would fail after Session resume. Treating search as activation would also create a second visible registry state beside the allow-only eligibility resolved by `dsh-tools`.

## Decision

`ToolDefinition.deferLoading` marks a registered definition whose schema is omitted from the initial request. The shipped base bundle enables `dsh-tools.toolSearch`, which contributes the reserved `tool_search` infrastructure schema. The search index is rebuilt from the calling Agent's current resolved view and contains only eligible deferred definitions. Its canonical result is the exact matched `ToolSchema[]`; it never registers, enables, or otherwise activates a tool. Model-authored search input is validated before indexing: `query` must contain non-whitespace text, and `limit` must be an integer within the configured maximum. Parameter schemas use draft-07 when `$schema` is absent and accept explicit draft-07 or the MCP JSON Schema 2020-12 dialect; unsupported dialect identifiers and malformed schemas fail discovery. The required deployment setting `maxResultBytes` limits the exact durable result block containing rendered content and `loadedTools` metadata.

The agent loop stores matched schemas on the durable `tool-result` block. Each prompt assembly treats those restored results as file input and reads them from `Session.deriveMessages()`. It rejects Proxy-backed candidates before record inspection, safely extracts only each candidate's own enumerable string `name`, discards names absent from the current eligible deferred view, and deduplicates the remaining raw candidates without reading nested schema data. Before canonical serialization, retained candidates must be accessor-free lossless JSON; this check rejects nested Proxies and accessors without invoking traps or getters. Assembly then serializes the raw eligible set as one canonical reconstructed discovery block, applies the current byte budget, and fully validates every retained `ToolSchema` before projection. Invalid or oversized current schemas fail assembly rather than reaching the model; malformed, unsupported, or huge stale entries cannot poison assembly or consume the discovery budget. The next request therefore carries the exact schema returned by search, while removal or a narrower allow-only contribution prevents stale history from restoring or dispatching it. `request/header` continues to record the complete assembled request tools, so replay has one authoritative request snapshot.

`schemas()` represents the initial model request and omits deferred definitions. `catalogSchemas()` represents the complete current eligible end-tool catalog for Host and inspection surfaces. MCP instances opt in per server with `deferLoading`; their complete live generation remains registered throughout discovery, and the client rejects that configuration before connecting when `toolSearch` is disabled. PTC mode carries schemas from nested `tool_search` sub-dispatches onto the outer `run_code` result. The same package-owned budget function measures each direct search, that final merged outer result, and the reconstructed eligible set. Aggregate overflow becomes the outer canonical failure before notification or logging and cannot retain partial `loadedTools`.

Discovery metadata describes only the final committed model-visible success. A post-execute or around-execute replacement, block, error, or definition-owned content replacement clears the execution's candidate `loadedTools`; a policy result cannot retain schemas from an earlier body result whose value or content it replaced.

Provider-neutral adapters receive the ordinary `tool_search` call, its JSON schema result, and the expanded next-request tool list. The pi-ai bridge additionally maps the durable result to `addedToolNames`; OpenAI Responses models that support native tool search receive equivalent `tool_search_call` and `tool_search_output` history with `defer_loading` schemas. Both paths derive from the same provider-neutral Session log.

## Verification

Registry tests prove model-input and restored-file validation, draft-07 and JSON Schema 2020-12 compatibility, configured count and byte caps across direct, composite PTC mode, and reconstructed results, initial omission, eligible catalog retention, exact schema results, final-result metadata, durable next-request and resume reconstruction, PTC mode binding execution, mode-specific prompt ordering, reserved-name collision rejection, and filtering before restored-result budgeting after allow-only eligibility changes. MCP lifecycle tests prove per-server deferral and fail-loud discovery misconfiguration. Pi-ai tests prove provider-neutral metadata conversion and the native OpenAI Responses request payload. The keyless headless snapshot applies its deterministic replay and MCP overrides to the shipped headless profile, discovers and calls the official MCP server's deferred `echo` tool, persists canonical JSONL, disposes the Loader tree, reloads the same Session, and verifies the reconstructed request header. A negative composition check removes the shipped `toolSearch` patch and requires that same scenario to fail.

## Alternatives considered

**Mutate a per-Agent active-tool set.** Rejected because discovery is evidence returned to the model, not an authorization or registration transition. A mutable active set would duplicate eligibility and require a new durable state machine.

**Recompute matched schemas from the current registry after search.** Rejected because schema changes between search and continuation would make the request differ from the result the model read. The log stores the returned schemas and uses the current registry only to recheck continued eligibility.

**Persist only matched names.** Rejected because names cannot reconstruct the exact model-visible schema and would make resume depend on current provider output.

## Consequences

Deployments can keep large MCP generations registered and executable without paying their full initial schema cost. Search results add schema JSON to history and change later request tools, so discovery still has a token cost. A model that guesses a registered eligible name may call it without a prior search; this is intentional because search does not activate tools. Eligibility remains the sole authority over discovery and dispatch.

MiniSearch supplies maintained ranked name-and-description retrieval instead of a repository-owned search implementation. Ajv supplies draft-aware JSON Schema validation for generated and restored schemas, including MCP schemas outside the narrower first-party authoring DSL. The runnable headless example declares the official MCP server it executes directly, so plain-Node built resolution does not depend on another workspace package's development dependencies.
