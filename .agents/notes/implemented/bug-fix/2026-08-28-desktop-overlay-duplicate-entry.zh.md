# Agent Note: Desktop 叠加层不得重复插入 roster 行,组合 boot 负责证明

Status: implemented

[English](2026-08-28-desktop-overlay-duplicate-entry.md) | 中文

## Problem

#438 的 Desktop 叠加层插入了一条 web-app roster 已有的 `ui-phone` loader 行。叠加层压到 roster 上之后,Loader 在实例化阶段即以 `TypeError: duplicate loader entry id: ui-phone` 中止,Desktop Host 在宣布任何 URL 之前就退出。缺陷溜进来的原因:该叠加层既有的验证(`overlay-isolation.spec.ts`)用 `--dump-config` 组合配置文本,从不实例化 entries——重复 entry id 在该阶段不可见。

## Decision

Desktop 叠加层不再插入 `ui-phone`:web-app roster 是该行唯一的提供方,叠加层只保留 `DSH_PHONE_MOBILECLI` 门控的 `phone-runtime` / `phone-stream` / `tool-phone` 三行。回归不是文本比对,而是组合 boot:`apps/desktop/tests/overlay-boot.spec.ts` 经 `spawnWebHost` 拉起 roster + 叠加层组合,要求出现 `dsh web:` 环回 URL 宣布,并要求入口页应答 200。Loader 在这次 boot 中实例化每个组合出的 entry id,重复 id 会在宣布前杀死进程,失败输出携带子进程尾部。

## Alternatives considered

**静态断言叠加层不插入任何 roster id。** 拒绝:两份人工维护的 id 清单必然漂移,未来 roster 新行会重新打开缺口;boot 观察的是 Loader 的真实契约。

**扩展 `--dump-config` 组合测试。** 拒绝:dump 阶段的组合正是放过重复插入的盲区;它证明不了 entry 实例化。

## Consequences

任何叠加层/roster 的 id 冲突现在都会在 keyless 单测车道内数秒失败,早于打包与真实 Desktop 启动。`--dump-config` 断言保留用于顺序与语义检查,但不再充当叠加层的装载期防护。
