# @deepseek-ai/dsh-browser-runtime

[English](README.md) | 中文

这是与 Provider 无关的浏览器控制 Service Definition。`ctx.browserRuntime` 创建一个临时、命名持久或共享 Browser Profile 层级，并以带品牌类型的 `BrowserProfileId`、`BrowserWorkspaceId`、`BrowserInstanceId` 与 `BrowserTabId` 标识每次操作。

## 服务 API

`create` 返回修订号为 `0` 的初始打开状态。省略 `attach` 会新建 Workspace 与浏览器实例。附加到 Workspace 会再开一个实例；附加到浏览器实例会再开一个标签页。临时请求在关闭后丢弃身份。持久请求命名一个隔离 Browser Profile，并在之后恢复同一 `persist:session-*` partition。共享请求复用安装范围内的 `persist:session-*-shared` partition，且不占用 `BROWSER_PROFILE_BUSY`。`navigate`、`focus`、`input` 与 `close` 要求调用方提供最后观察到的 `expectedRevision`；Provider 串行执行操作，并用 `BROWSER_REVISION_CONFLICT` 拒绝过期写入。Agent 合成 `input` 要求 URL、文本或两者，并递增修订号。同一命名 Profile 的第二个独立写入方会以 `BROWSER_PROFILE_BUSY` 拒绝；附加到已打开的命名 Profile 会为该写入方再增加实例或标签页。`observe` 与 `screenshot` 只读。`close` 返回保留全部四个不透明身份的终态回执。打开状态还携带地址栏 `chrome` 与 `storage`。存储隔离来自 `chrome.partition` 上的 Chromium partition；除非 Provider 观察到这些字段，否则它们保持为空。临时 chrome 不带标签。共享 chrome 使用保留的共享身份名称。Service Definition 为每个方法记录其适用的稳定 `BrowserRuntimeError` code。

`BrowserRuntimeState` 携带打开、`unavailable` 与关闭三种状态。`unavailable` 状态是对既有 target 的 Provider 可用性丢失的真实投影：它保留 target 与最后修订号，说明原因（`crashed`、`unhealthy` 或 `reconnect-failed`），并标记进行中的重连；它不是终态关闭回执。针对不可用 target 的操作会以 `BROWSER_RUNTIME_UNAVAILABLE` 拒绝；无法解释其后端响应的 Provider 会以 `BROWSER_PROTOCOL` 拒绝。

Provider 在 `browser/runtime-state` 上发布已提交状态。该通知不可否决提交：每个同步抛错或异步拒绝都会被容纳，后续 listener 继续运行，且 Provider 不等待异步 listener 工作。带状态的 Provider 负责验证该可变关系；本定义包只负责类型、服务名称，以及 Provider 调用的共享队列、身份与通知辅助函数。

## 模型体验

通过负责渲染 Browser Runtime 结果的 dsh-tool-browser Consumer 间接影响模型。

#### KV 缓存影响

本包自身不增加模型 token，也不改变请求前缀。

## 已知限制与后续工作

- Dock chrome 见 [`dsh-client-ui-browser`](../../client/ui-browser/README.md)。Session 本地 Workspace 所有权见 [`dsh-browser-workspace`](../browser-workspace/README.md)。
