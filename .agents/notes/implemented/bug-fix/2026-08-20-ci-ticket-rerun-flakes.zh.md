# Agent Note: 票级重跑 CI 握手改为确定性

Status: implemented

[English](2026-08-20-ci-ticket-rerun-flakes.md) | 中文

## Problem

[2026-08-19-inherited-ci-baseline-reds](2026-08-19-inherited-ci-baseline-reds.zh.md) 的基线修复合并后，所有仍打开的 Mobile Companion 票级 PR 仍然在重叠 CI 车道上失败。其中两处是基线 flake，会挡住每一个走到对应门禁的 PR，而不是票级内容本身。

DeepSeek 默认值无头快照（`keeps provider comments alive and sends DeepSeek defaults through the one-shot app`）把 `streamIdleTimeoutMs` 设为 150，以便 SSE 注释必须给适配器空闲看门狗续期。该看门狗在 `stream()` 等待第一个迭代值时武装，而这发生在 `fetch` 收到响应字节之后。原先的 mock 只在 `request` 的 `end` 上才写响应头和第一条注释，随后再用 `setTimeout` 推迟后续注释。在 consumers 车道负载下，从武装到首字节的间隔会超过 150ms，适配器以 `TIMEOUT` 中止，`dsh-llm-retry` 发出第二次 POST，快照则断言 `requests.length === 1`。即便在 `end` 之后立刻写第一条注释，只要 `end` 本身来晚了，窗口照样会丢。

process-exit 的宿主退出套件会先等 `ready` 再读 `tree.json`，但宿主仍在 `access()` 成功后立刻解析该文件。`writeFile` 会在 JSON 载荷落盘之前就创建路径，因此负载下的 coverage worker 可能对空前缀执行 `JSON.parse`（`Unexpected end of JSON input`），以退出码 1 结束，并使 `removes an ordinary managed tree after 'unhandled-rejection'` 失败。

## Decision

**默认值快照 mock 在请求到达时就写出第一条 SSE 注释。** 响应头和 `: keep-alive` 在请求体读完之前离开套接字，因此 `fetch` 会解锁。真正在这条路径上证明 keep-alive 的空闲预算和后续注释/载荷时间表见 [CI 可承受的空闲保活笔记](2026-08-20-headless-defaults-idle-keep-alive.zh.md)。

**managed-tree fixture 原子发布 `tree.json`，宿主等待合法 JSON。** 子进程写入同级 `.tmp` 再 `rename` 到 `tree.json`。宿主重复 `readFile` + `JSON.parse`，直到 `root` 与 `descendant` 都是安全整数，并把 `ENOENT` 与 `SyntaxError` 视为尚未发布。`access()` 不是载荷就绪信号。

## Verification

`examples/headless-agent/tests/headless.snapshot.ts` 中的 `keeps provider comments alive and sends DeepSeek defaults through the one-shot app` 对着进程内 mock 在本地通过。`packages/subprocess/subprocess-local/tests/process-exit.spec.ts` 在本地通过，包括 `removes an ordinary managed tree after 'unhandled-rejection'`。

## Alternatives considered

**快照里继续延迟注释，只在 `end` 之后刷出首字节。** 否决：`end` 仍落在负载下的事件循环上，150ms 首字节窗口仍是竞态。适配器单元测试已经用假时钟钉住延迟注释。

**接受 `requests.length >= 1` 并要求重试体相同。** 否决：这会把 TIMEOUT 重试藏起来，而不是消除中止。快照必须证明一次成功的 one-shot POST。

**保留 `waitForFile(access)`，只加长宿主超时。** 否决：空的 `tree.json` 会立刻以 `SyntaxError` 失败，而不是超时。宿主必须等到一份完整的已发布记录。

## Consequences

请求到达即写第一条注释的握手仍是必需的，这样 `fetch` 才能在空闲预算内解锁。它本身不能在负载 runner 上把 150ms 看门狗续住；[CI 可承受的空闲保活笔记](2026-08-20-headless-defaults-idle-keep-alive.zh.md) 拥有那张时间表。coverage 车道不再从该握手继承截断 `tree.json` 造成的宿主崩溃。票级自有的 oxlint、目录、knip 和覆盖率阈值失败仍留在那些 PR 上。
