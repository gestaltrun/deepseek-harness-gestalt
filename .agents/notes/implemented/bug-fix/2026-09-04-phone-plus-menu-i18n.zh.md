# Agent Note: 本地化 + 菜单「手机」标题

Status: implemented

[English](2026-09-04-phone-plus-menu-i18n.md) | 中文

## Problem

better-sidebar 的 + 菜单与占用「手机」tab 标题在 Node 安全的 `registry.ts` 里写死为中文（`手机`、`手机·<name>`）。英文界面因此在 Phone 行显示中文。Issue #565。

## Decision

`registry.ts` 保持 Node 安全，不 import locale。`PHONE_TAB_TITLE` 仍为 `'手机'`，`phoneTabTitleOf(name)` 仍为 `` `手机·${name}` ``，供 Node invariant 测试与直接调用该辅助函数使用。实际标题是 `PhoneTabOptions` 上的函数：`title: () => string` 与 `occupiedTitle: (name: string) => string`。`buildPhoneTabDescriptor` 赋 `title: options.title`。`createPhoneTabSwitcher`、`showPhonePicker`、`openPhoneDevicePanel` 与 `installPhoneTab` 接收这些函数；浏览器路径不用 `phoneTabTitleOf` 生成实际标题。

浏览器 `apply()` 注册 `settings.phone-devices` 后 bind `t`。`title` 为 `() => t('tab')`。`occupiedTitle` 为 `(name) => `${t('occupied')}${name}``。词典：zh `tab: '手机'`、`occupied: '手机·'`；en `tab: 'Phone'`、`occupied: 'Phone · '`（间隔号两侧有空格）。英文占用标题为 `Phone · Pixel_6_API_35`。

`apply()` 只订阅 locale 变化。每次通知从当前 better-sidebar snapshot 读取已打开的单例 Phone tab，经 `phoneDeviceTabMetaOf` 解析其持久化 `meta`，再用仅含本地化 `title` 的 patch 调用 `updateTab`。选择器或无效设备 meta 使用 `title()`；占用 meta 使用 `occupiedTitle(meta.name)`。tab 保持 mounted，且不会改写其 `meta` 引用。

## Alternatives considered

**在 `registry.ts` 中 import locale。** 拒绝：Node invariant 伴生体 import 该模块，必须保持无 JSX、无 locale。

**占用键使用插值模板 `手机·{name}` / `Phone · {name}`。** 拒绝：apply 拼接前缀，binder 不必插值，且中文 `·` 两侧无空格。

**在 locale 的 `Record<string, string>` 里放函数值。** 拒绝：词典保持字符串映射。

## Consequences

默认 zh 仍显示「手机」。英文 + 菜单与选择器标题显示 Phone；占用标题显示 `Phone · <name>`。Desktop overlay 夹具可以保留假的 `手机` 标签。其余选择器与连接文案仍是中文。

## Related

descriptor 注册仍见[tab 骨架](../architecture/2026-08-27-ui-phone-tab-skeleton.zh.md)。回到选择器仍见[侧栏实时清单](2026-09-04-ui-phone-sidebar-picker-live-listing.zh.md)。
