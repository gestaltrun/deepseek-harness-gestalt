---
description: "Service Definition and registry for deployment-owned exact child LLM route authorization."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-route-preauthorization

English | [中文](README.zh.md)

## Summary

This package declares the abstract `ctx.subagentRoutePreauthorization` Service Definition for one deployment-owned exact child LLM route snapshot. Consumers sample it only while composing a fresh top-level Session; the service does not read or write user Settings.

## Use this package

Mount one Provider such as [`dsh-subagent-route-preauthorization-static`](../subagent-route-preauthorization-static/README.md). The Provider owns service lifetime, and Cordis injection lets an optional Consumer activate when the service appears and dispose its deployment-enabled registration when the Provider leaves.

`snapshot()` returns detached immutable `{ provider, model }` records. A Consumer unions this deployment snapshot with any enabled user authorization, sorts and deduplicates the result, and records it durably before exposing route selection. Resumed and child Sessions read only that recorded policy.

## Model Experience

Indirectly, through a Consumer that records the snapshot as a Session route-selection policy.

#### KV Cache effect

The service itself adds no model tokens. A Consumer may expose stable route-selection schemas from the durable Session policy.

## Known Limitations and Deferred Work

- **One Provider per service scope** — combine deployment routes inside the Provider configuration; user authorization remains a separate Consumer-owned union input.
