# Agent Note: First-run does not mint official DeepSeek

Status: implemented

English | [中文](2026-08-22-first-run-does-not-mint-official-deepseek.zh.md)

## Problem

First-run Models listed never-written official DeepSeek (`deepseek-official`) and the onboarding dialog asked for that adapter's API key. Adding the pi-ai catalog route `deepseek` stored `DEEPSEEK_API_KEY`, the same reference official DeepSeek joins, so an unoccupied official row appeared beside the catalog row the user had just added.

Users need catalog `deepseek` in Add a provider. They do not want first-run to mint official DeepSeek.

This reverses the never-written listing rule in [First-run official DeepSeek listing](2026-08-20-first-run-official-deepseek-listing.md). Occupancy, leftover `user: {}`, and delete folding remain there.

## Decision

`listedProviderRows` paints a row only when occupancy or a described `credential.configured === true` holds. A never-written official section stays off the list. When catalog `deepseek` is configured, an unoccupied official row stays off even if that shared `DEEPSEEK_API_KEY` is stored.

Add a provider still offers catalog `deepseek` and never offers `deepseek-official`.

The onboarding step `configure-models` no longer collects an official key. With no usable provider it opens Settings → Models; Configure later completes the step without opening Settings.

## Alternatives considered

**Withhold catalog `deepseek` while official DeepSeek is mounted.** Rejected because users add that catalog route on purpose; hiding it does not remove `deepseek-official`.

**Keep listing never-written official DeepSeek so first-run has a key field.** Rejected because that is minting official DeepSeek without the user adding it.

## Consequences

A first-run Models page starts empty except Add a provider. Official DeepSeek appears only after occupancy or a stored credential that is not already claimed by configured catalog `deepseek`. The composer model catalog also omits official DeepSeek while the `llm-deepseek` settings section is registered and unoccupied, so a new session does not offer that adapter's models. The official adapter stays mounted as a composition fact.

## Testing

`packages/client/ui-settings-models/tests/components.client.spec.tsx` pins never-written official DeepSeek off the list, catalog `deepseek` remaining addable, and a configured catalog `deepseek` hiding unoccupied official DeepSeek. `packages/client/ui-settings-models/tests/onboarding-dialog.client.spec.tsx` pins Open Settings calling `openSection('models')` and Configure later completing without it. `packages/client/ui-settings-models/tests/readiness.client.spec.ts` pins `needs-config` when nothing is usable. `packages/host/apiproxy/tests/api-proxy-config.spec.ts` pins the model catalog omitting official DeepSeek while `llm-deepseek` is unoccupied and keeping it once occupied.
