# Agent Note: 恢复票内 per-file 覆盖率清单

Status: implemented

[English](2026-08-21-coverage-inventory-restore.md) | 中文

## 问题

#182 让 coverage lane 重新执行 per-file 100% 之后，有三十一份 Gestalt 文件未达清单。后续 PR 补了归属测试，又把这些文件写进 `vitest.config.ts` 的 `coverage.exclude`（`TODO(gui)` 与 `TODO(#168,#170)`）。覆盖率 lane 变绿但排除票内产品文件，不满足 #185。

## 决策

从 `coverage.exclude` 去掉 #185 列出的路径。Desktop Account/updater、附件 lightbox/图片、Schedule 列表、Models 编辑器/标签、Platform HTTP/Redis/client 入口、Schedule 插件入口、session-log 导出、loader-smoke、Markdown 文本、Web Search 卡片，以及 API-proxy fetch 的既有归属测试已经达到 per-file 100%。`web-search-deepseek` 的 `index.ts` 补上凭证回退与 ByteString 拒绝用例，使 `resolveApiKey` 不再把这些分支留在清单外。#185 未点名的其它 `TODO(gui)` 排除保持不动。

本笔记取代[基线既有 CI 红灯笔记](../bug-fix/2026-08-19-inherited-ci-baseline-reds.zh.md)中关于剩余排除的句子。

## 考虑过的替代方案

**把票内文件继续当作 GUI 或 companion 债务排除。** 否决：#185 要求补测试，或给每个文件写出正当排除。这些文件已有归属测试；不正当的是排除清单。

**改写这三十一份文件以缩小分支，而不是测量它们。** 否决：缺口在清单，不在 API。

## 后果

在此 head 上的纯 workflow PR 必须在不把这三十一份路径写入 `coverage.exclude` 的前提下保持 Linux coverage lane 为绿。`web-search-deepseek` `resolveApiKey` 的新分支在合并前需要覆盖用例。

## 验证

对每条恢复路径使用 `--coverage.include` 的聚焦 Vitest 覆盖率为 per-file 100%，包括 `packages/web/web-search-deepseek/tests` 与 `packages/host/apiproxy/tests/{session-export,fetch-carrier,client-handler}.spec.ts`。
