# Agent Note: 在 Desktop overlay + 菜单绘制手机图标

Status: implemented

[English](2026-09-03-desktop-overlay-phone-menu-icon.md) | 中文

## 问题

Desktop 侧栏 `+` 菜单里 Files、Source Control、Tasks、Side Chat、Terminal、Browser 都有前导图标，「手机」只有文字。同一窗口的手机 tab 标签已经有听筒图标。TabBar 把 `icon: option.id`（`phone`）序列化进原生 overlay 请求；`overlayMenuIcon` 只映射 `editor|git|subagent|sidechat|browser|terminal`，未知 id 返回 undefined，该行不画图标。网页内 Menu 会拿到 `PhoneTabIcon`，但 Desktop 始终走 overlay。

## 决策

`overlayMenuIcon('phone')` 返回与 `PhoneTabIcon` 一致的 overlay 本地 16×16 单色听筒（viewBox `0 0 16 16`，stroke 1.3，`currentColor`）。ui-primitives 没有手机图标。ui-phone 已经依赖 ui-desktop，导入 `PhoneTabIcon` 会成环。未知 id 仍返回 undefined。

## 考虑过的替代方案

**从 ui-phone 导入 `PhoneTabIcon`。** 拒绝：ui-phone 已把 ui-desktop 列为 peer，overlay 包不能反向导入。

**在 primitives 新增手机图标并共享。** 本次修复拒绝：没有现成 primitives 字形，把听筒提升到图标集超出「补回 overlay 行图标」的范围。

## 后果

Desktop overlay `icon: 'phone'` 行绘制与标签条相同的听筒。以后若抽到 primitives，只需替换 overlay 本地 SVG，不必改 id 映射。

## 测试

`packages/client/ui-desktop/tests/desktop-chrome-overlay.client.spec.tsx` 要求 `overlayMenuIcon('phone')` 为真、`icon: 'phone'` 的菜单项含 16×16 SVG，且未知 id 仍无图标。
