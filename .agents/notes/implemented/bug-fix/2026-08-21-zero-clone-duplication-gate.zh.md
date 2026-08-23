# Agent Note: 恢复零克隆 duplication 门禁

Status: implemented

[English](2026-08-21-zero-clone-duplication-gate.md) | 中文

## 问题

`pnpm run duplication` 只有在五处已开票的产品克隆藏在 `jscpd:ignore` 注释后才保持绿灯：Desktop Account／pairing bind、Jobs／Schedule 列表的 Escape 处理、两条 Platform HTTP JSON／错误路径，以及两个脚本 snapshot runner。提高 `minTokens`／`minLines` 或把这些文件加入 `.jscpd.json` 的 `ignore`，会让门禁对产品代码说谎。

## 决策

只在所有权与依赖方向仍然成立的地方抽取共享逻辑。`@deepseek-ai/dsh-host-webserver` 持有参数化的 `readJsonObject`、`writeJson`、`writeHttpError`、`writeRetryAfterError` 与 `HttpError`。Platform Account HTTP 与 Remote Access HTTP 自行传入状态码、错误码与文案；领域映射（`AccountError` 对 `RemoteAccessError`，401／400 对 409）留在各自 Consumer。Desktop Account 与 pairing 通过 `ui-desktop` snapshot source 里的 `bindDesktopSnapshot` 绑定。Jobs／Schedule 的 Escape 处理与两个脚本 snapshot runner 在去掉 ignore 注释后不再达到门禁阈值，因此只删注释、不新增共享模块。`.jscpd.json` 保持 `minTokens: 60`、`minLines: 6`，并继续忽略 `**/tests/**`。有意并行的实现（bash／pwsh、包 invariant、Trajectory Definition）保留现有源码区间例外。

本笔记取代 [继承基线 CI 红灯笔记](2026-08-19-inherited-ci-baseline-reds.zh.md) 中关于 HTTP `jscpd:ignore` 的句子。

## 考虑过的替代方案

**因各 Consumer 自持状态行文案而继续给 HTTP reader 加 `jscpd:ignore`。** 否决：门禁仍会排除已开票的产品代码。参数化助手把文案留在调用点。

**把助手放到新的 `platform-http` 包。** 否决：两个 Consumer 已经依赖 `dsh-host-webserver`，这些助手是带调用方错误码的通用 HTTP JSON 读写，不是 Platform 能力。

**把助手放到 `platform-account`。** 否决：Remote Access HTTP 会为 HTTP 管道去依赖 Account 服务定义，所有权反转。

**把 Jobs／Schedule Escape hook 抽到 `ui-primitives`，或在 `scripts/` 抽 snapshot runner 助手。** 否决：去掉 ignore 注释后这些成对代码仍低于当前阈值，且 client 插件不得导入另一插件的值。

**提高 `minTokens`／`minLines` 或忽略这些产品路径。** 否决：这正是票面写明的验收失败。

## 后果

duplication 门禁在 `packages` 与 `scripts` 上报告零克隆，且不再排除已开票的产品文件。新的 Platform HTTP Consumer 可以复用 webserver 助手，但仍必须自带错误码与文案。Desktop bind 竞态留在一个函数里；Account 与 pairing 只点名各自的 Host 方法。

## 验证

`pnpm run duplication` 报告零克隆。聚焦的归属测试覆盖 `http-json.ts`、Platform Account HTTP 信封、Remote Access HTTP 组装路由，以及 Desktop Account／pairing bind。去掉已开票的 `jscpd:ignore` 注释后再跑门禁，仍报告零克隆。
