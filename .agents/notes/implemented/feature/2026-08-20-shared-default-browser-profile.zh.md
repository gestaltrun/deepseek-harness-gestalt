# Agent Note: 默认共享 Browser Profile

Status: implemented

[English](2026-08-20-shared-default-browser-profile.md) | 中文

## 问题

`browser_create` 默认创建一次性临时 Profile。省略 `profile` 的每次调用都会铸造新的隔离身份，并在关闭时丢弃。Session 无法复用同一套登录，模型必须同时给出 `persistent` 和 Profile 名，身份才能留下来。Session 持有的 AI Browser 规格旅程 6 要求单独标注、且不得声称 cookie 或存储隔离的 attached-user 身份；已交付运行时只有隔离的临时 Profile 与命名持久 Profile。

## 决策

`browser_create` 省略 `profile`，或传入 `profile: "shared"`，会打开本安装范围内的共享 Browser Profile。其 partition 为 `persist:session-${idPrefix}-shared`。`BrowserProfileId` 稳定。每次不带 attach 的创建都会在同一 partition 上开启一个 Session 持有的 Workspace，且不会触发 `BROWSER_PROFILE_BUSY`。地址栏 chrome 使用 `kind: "shared"` 与保留名 `shared`。Dock 文案写共享身份，不把该 Profile 呈现为隔离身份。

传入 `profile: "persistent"` 并带名称时，仍打开该隔离的命名 Profile。命名持久 Profile 的第二个独立写入方仍以 `BROWSER_PROFILE_BUSY` 拒绝。传入 `profile: "temporary"` 仍铸造一次性、无标签的身份。保留名 `shared` 不能作为持久 Profile 名。

这是本 Desktop 安装的共享 Chromium 身份。它不从系统 Chrome 或 Safari Profile 导入 cookie。[持久 Browser Profile Agent Note](2026-08-19-persistent-browser-profiles.zh.md) 仍持有命名隔离、命名 Profile 的单写入方，以及临时身份的丢弃。

## 考虑过的替代方案

**导入系统 Chrome 或 Safari 的 cookie 罐。** 否决，因为那是另一个产品：平台相关、隐私敏感，也不是一个 Browser Profile 名。共享 Profile 是本 Desktop 的 persist partition。

**省略 `profile` 时仍默认临时。** 否决，因为模型实际使用的默认会继续一次性且隔离，Session 永远不会共享登录，除非模型点名持久 Profile。

**复用名为 `default` 的命名持久 Profile，并保持 `kind: "persistent"`。** 否决，因为持久 chrome 声称的是隔离的命名身份。共享 chrome 必须是不同的 kind，Dock 与模型可见结果才能避免把它叫做隔离。

**共享 Profile 仍走 `BROWSER_PROFILE_BUSY`。** 否决，因为每个 Session 都必须能在同一身份上打开 Workspace。命名持久 Profile 仍是单写入方。

## 后果

未点名 Profile 的 Agent 会在各 Session 之间共享一套登录。点名持久 Profile 的 Agent 仍保持该 Profile 隔离。显式临时 Profile 仍是一次性的。共享 chrome 必须标注为共享身份。

## 测试

`packages/browser/browser-runtime/tests/types.spec.ts` 固定共享解析、保留名与 Workspace 序号。确定性、Electron 与 Tandem Provider 测试会打开两个共享 Profile 且不触发 `BROWSER_PROFILE_BUSY`，并断言同一 partition。`packages/browser/browser-workspace/tests/workspace.spec.ts` 从两个 Session 打开共享 Profile。`packages/browser/tool-browser/tests/tools.spec.ts` 把省略的 `profile` 固定为共享 chrome。`packages/client/ui-browser/tests/model.client.spec.ts` 固定共享身份地址栏标签。无密钥 Browser Runtime 快照通过传入 `profile: "temporary"` 保留临时 tracer，并固定更新后的 `browser_create` schema。
