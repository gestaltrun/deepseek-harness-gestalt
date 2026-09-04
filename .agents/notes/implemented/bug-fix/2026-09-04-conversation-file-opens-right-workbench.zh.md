# Agent Note: 对话文件打开落到右侧工作台

Status: implemented

[English](2026-09-04-conversation-file-opens-right-workbench.md) | 中文

## Problem

`openTab` 会落到 `activePane`。展开底部面板、点它的 `+` 菜单，或自动打开终端，都会让那个底部 pane 成为上次焦点。之后对话里的路径、produced-files chip、资源管理器行，或 `sidebar_open` 文件就会在底部工作台打开，而不是右侧栏。

## Decision

`BetterSidebarService.openTab` 是唯一落地入口。带 path 或 URL 的 seed 若 `activePane` 在底部树，会在 mint 之前改到右侧工作台的第一个 leaf，因此只带 URL、path 在 create 之后才补上的浏览器标签与文件走同一规则。纯类型的 `+` 点击没有这两个字段，仍跟随菜单所在 pane。已有实例仍在原地聚焦，包括浮动窗口。右侧工作台里已聚焦的 split 不会被改走。

## Alternatives considered

**所有 `openTab` 都落到右侧工作台。** 未采用，因为底部 `+` 菜单和首次展开时的自动终端必须继续在底部 pane 建标签。

**只钉住 `openSidebarFile`。** 未采用，因为 `sidebar_open`、produced-files chip 和 URL 接管共用 `BetterSidebarService.openTab` / `openFile`，不是那个 helper。

## Consequences

对话和智能体打开的文件会展开右侧面板。底部 pane 的终端和纯类型标签留在底部工作台，直到用户拖走。资源管理器的「在侧边打开」仍拆分源 pane。

## Testing

`packages/client/ui-better-sidebar/tests/open-tab-landing.client.spec.ts` 在底部 pane 为活动时通过 `openTab` 打开带路径的 editor、带 URL 的浏览器 seed，以及纯类型终端。
