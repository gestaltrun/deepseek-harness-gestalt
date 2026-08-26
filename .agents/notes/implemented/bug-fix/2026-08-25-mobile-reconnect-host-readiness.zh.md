# Agent Note：Desktop Host authority 重连时保持 Mobile 可读

状态：已实现

[English](2026-08-25-mobile-reconnect-host-readiness.md) | 中文

## 问题

Desktop 会在 Web Host 宣告 loopback URL 之前启动 Personal Pairing Relay access。前台 Mobile 可能已经完成 Relay authentication，并在 `DesktopCompanionProductOwner` 仍无 Host authority 时请求所选 Session。Desktop 随后断开时，`MobileBrowse` 还会在 Foreground Synchronization 已关闭后请求缺失 history；同步 refusal 会逃出 React effect，并卸载完整 Mobile tree。

Live presentation clock 每次 render 都通过新函数订阅。因此 React 会在 connection-state render 之间 detach 并重新 attach 唯一 clock observer，刷新 clock snapshot，并在同一故障序列中增加不必要的 update path。

## 决策

Packaged Desktop 只有在 Web Host 安装后才启动 signed-in Personal Pairing。它会调度该 lifecycle start，而不延迟 `window.loadURL()`，因此保留的 Mobile Access 状态或缓慢的 Relay attachment 不会在 Host 已可用时让 Desktop window 保持空白。Account sign-in 与 process resume 使用同一个 readiness predicate，因此在初次或 replacement Host startup 尚未完成时唤醒进程，不会重启 Relay access。Pairing controller 会在一个 lifecycle generation owner 内串行 start、deactivate 与 replacement start；它在 refresh 前后复核捕获的 Host predicate，以 `host-unavailable` 停止 stale in-flight start，并只在清理结束后接纳 replacement。只有当所属 generation 已 stale 时，Relay startup 的 typed `REMOTE_OFFLINE` 才是已完结的 cancellation；无关的 refresh failure 仍进入 shutdown aggregation。Host exit 仍会保留此前已建立的 Relay 足够长时间，以返回 typed Host failure；generation cancellation 只适用于尚未建立当前 Host authority 的 in-flight startup。

`MobileBrowse` 在没有当前 mutation authority 时绝不请求 history。Synchronization 丢失会清除其本地 history-request fence，使后续 synchronized generation 可以请求缺失 conversation。Clock subscription callback 在其 clock owner 生命周期内保持稳定。

## 考虑过的替代方案

**让 Mobile 用 timer 重试每个 Host-unavailable history response。** 拒绝，因为这会把 Desktop startup latency 变成无界 encrypted request loop，并隐藏错误的 Online state。

**只 catch 同步 history error。** 拒绝，因为页面虽能保持 mounted，却会保留阻止 synchronized generation 加载 conversation 的 request fence。

**Relay authentication 后不再投影 Host failure。** 拒绝，因为 Host 可能在有效 connection 建立后失败，Mobile 必须继续展示 typed HTTP、wire、business 与 timeout result。

## 后果

Desktop replacement 会让已打开 Mobile conversation 与 cached row 保持可见，离线时禁用 mutation control，并只在 Host authority ready 后恢复相同 encrypted channel。Desktop window loading 与 Relay readiness 相互独立，而 shutdown 会排空 controller 拥有的后台 start，并完结其 typed Relay cancellation。Foreground disconnect 不会再把 `Companion history requires foreground synchronization` 抛进 React。已建立 Desktop 在线之后发生的 Host failure 仍是 application data，而不是 Relay disconnect。

## 测试

Desktop readiness coverage 会为所有不完整 Account/Host 组合保持 pairing stopped，并把 current-generation predicate 交给 controller。Lifecycle coverage 会交错 slow old start、Host replacement stop 与 new start，并证明最终只有 replacement 拥有 Relay。Mobile coverage 会拒绝 offline history submission，并在多次 render 之间只保留一个 clock subscription。保留 Mobile Access 的 Packaged Desktop 会在现有 pairing 完成 Relay startup 前加载 Web Host window。Desktop stop 与 replacement 期间，Android 已打开 conversation 保持 mounted，离线时 composer disabled，恢复时不出现 Host-unavailable error；in-place APK upgrade 还保留了 Account、pairing、key 与 cache。
