---
description: "Static Provider that contributes deployment-owned exact child LLM routes."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-route-preauthorization-static

English | [中文](README.zh.md)

## Summary

This package is the Static Provider for `ctx.subagentRoutePreauthorization`. Its required `allowedModels` array is deployment configuration, independent of user Settings.

## Use this package

Mount this default-export Service Provider with non-empty provider and model ids. Direct programmatic construction and Loader configuration both reject malformed entries. The Provider copies, deduplicates, and sorts its routes before publishing the immutable service snapshot.

Consumer-first and Provider-first composition both settle through the Consumer's Cordis injection. Disposing this Provider removes the service and its deployment-enabled Consumer registration; reinstalling it publishes one fresh snapshot.

## Model Experience

Indirectly, through the Consumer that snapshots the contributed routes into a fresh top-level Session.

#### KV Cache effect

The Provider adds no tokens directly. A recorded Session policy keeps the Consumer's route-selection schema stable after Provider replacement.

## Known Limitations and Deferred Work

- **Static lifetime configuration** — changing routes requires replacing the Provider fiber; existing Session policies remain unchanged.
