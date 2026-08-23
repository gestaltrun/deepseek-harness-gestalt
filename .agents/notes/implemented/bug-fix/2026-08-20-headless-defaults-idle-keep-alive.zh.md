# Agent Note: 无头默认值快照使用 CI 可承受的空闲保活时间表

Status: implemented

[English](2026-08-20-headless-defaults-idle-keep-alive.md) | 中文

## Problem

DeepSeek 默认值无头快照必须在组装后的 one-shot 路径上同时证明两件事：SSE 注释会给 `streamIdleTimeoutMs` 续期，以及适配器默认值（`max_tokens`、`reasoning_effort`）到达提供方。[票级重跑握手笔记](2026-08-20-ci-ticket-rerun-flakes.zh.md) 在请求到达时写出第一条注释，并在 `end` 上立刻结束流、不再延迟。这把 keep-alive 证明从快照里拿掉了，却仍把 `streamIdleTimeoutMs: 150` 架在每一段调度间隙上，包括 TCP 刷出和两次 write 之间的事件循环延迟。负载下的 consumers 车道仍会以 `TIMEOUT` 中止，`dsh-llm-retry` 发出第二次 POST，`requests.length === 1` 在该握手合并后的 PR #179 上再次失败。

## Decision

**快照保留两项证明，并把空闲预算按 CI 来定。** `streamIdleTimeoutMs` 为 5000ms。mock 在请求到达时写出响应头和第一条 `: keep-alive`，随后在 2000ms 与 4000ms 再写注释，确定性载荷在 7000ms 到达。缺少一次注释续期会在载荷之前耗尽 5000ms 预算；负载 runner 上数百毫秒的抖动不会。`requests.length === 1` 保留：TIMEOUT 重试是 fixture 失败，不是可接受的产品行为。假时钟适配器单元测试（`keeps an idle provider read alive through SSE comments`）仍钉住亚秒级注释续期。

## Verification

`examples/headless-agent/tests/headless.snapshot.ts` 中的 `keeps provider comments alive and sends DeepSeek defaults through the one-shot app` 对着进程内 mock 连续五次本地通过。

## Alternatives considered

**保留 `streamIdleTimeoutMs: 150`，只更早刷出第一条注释。** 否决：负载 runner 上任何 150ms 投递间隙都会再次触发 TIMEOUT，包括首字节之后的间隙。

**在重试体相同时接受 `requests.length >= 1`。** 否决：那会藏起 TIMEOUT 中止。快照必须证明一次成功的 POST。

**放弃组装路径上的 keep-alive，只留给假时钟单元测试。** 否决：单元测试 mock 了 `fetch`。快照才是武装真实空闲看门狗的 one-shot 组装。

## Consequences

注释不再续期看门狗，或默认值从 POST 消失时，快照仍会失败。consumers 车道事件循环停几百毫秒时，它不再失败。[票级重跑握手笔记](2026-08-20-ci-ticket-rerun-flakes.zh.md) 里该 fixture 的 150ms 时间表已被取代。
