# Agent Note: Desktop 在已提供更新时仍复检 feed

Status: implemented

[English](2026-09-04-desktop-updater-available-recheck.md) | 中文

## 问题

Update Control 的「下载 {version}」来自最近一次 `update-available` 载荷。进入该阶段后，`startAutoUpdater` 会跳过 15 分钟一次的 GitHub feed 检查，因此后续 `latest.yml` 中的更新版本不会替换已提供的版本。只有重启 Desktop 才能看到更新的已发布包。

## 决策

`available` 仍按同一间隔以及 `checkNow` 复检 GitHub feed。探测期间控件保持 `available`：`checking-for-update` 不会隐藏它，后续 `update-available` 会替换 `newVersion`，`update-not-available` 则回到 `idle`。`available` 期间的复检错误会保留已提供的版本，而不是切到 `error`。下载、准备、已下载和正在安装仍跳过该间隔，以免替换进行中的安装包。

## 考虑过的方案

**保持 `available`，直到用户下载或重启。** 否决，因为之后的 GitHub Release 会在整个 Desktop 进程内不可见。

**每次复检都切到 `checking`。** 否决，因为探测期间控件会消失，用户会失去下载操作。

**把复检失败当成 `error`。** 否决，因为短暂的 feed 失败会隐藏仍有效的安装包。

## 后果

在用户尚未开始下载时，提供的版本会跟随当前 GitHub latest。测试固定版本替换、静默复检错误，以及无法打断 `download()` 的进行中复检。

## 测试

`apps/desktop/tests/updater.spec.ts` 驱动 `available` → 更新的 `update-available`、被拒绝的静默复检，以及与 `download()` 竞态的复检。
