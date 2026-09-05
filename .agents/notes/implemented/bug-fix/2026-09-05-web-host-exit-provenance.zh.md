# Agent Note: Web Host 就绪后退出出处

Status: implemented

[English](2026-09-05-web-host-exit-provenance.md) | 中文

## 问题

Desktop 观察 Web Host 死亡时只有 `Promise<void>`。会写出 `code`/`signal` 的 `exit` 监听器在 URL 宣布后直接返回，因此正在服务时退出的 Host 与主动 stop 无法区分。`planHostExit` 仍可 respawn 或显示错误页，但运维无法判断 Desktop 是否请求过停止。

该记录只是**直接 Node 子进程**的 wait(2) 事实。它不证明 renderer、GPU 或 mobilecli 后代已消失。Host 死后按记录 PID 发 SIGKILL 不是 containment：PID 复用与快照后逃逸的后代仍未解决。

## 决定

`RunningWebHost.exited` 解析为冻结的 `WebHostExit`：`pid`、`code`、`signal`、`requestedStop`。该记录**不含**子进程 stdout/stderr。就绪后不保留原文日志。

就绪前 timeout 与提前退出错误对**一整段内存 `startupBuffer`** 先脱敏再截断。该缓冲在 URL 宣布前**无界**，宣布后清空。启动缓冲沿用既有契约；本切片不宣称 Host 生命周期内有界存储。没有流式采集器，也不会在行中途把 `pending` 清空。

`requestedStop` 是闭合联合：`none`（非请求）、`stop`（`RunningWebHost.stop`）、`abort`（command AbortSignal）。先到的原因生效。`stop()` 与 abort 共用同一记忆化 request/join；Promise 在 `kill` 之前发布。kill 失败会拒绝该 Promise。就绪后 abort 若没有 `stop()` 等待者，不会默默丢掉 kill 失败：Desktop 发出 `DSH_WEB_HOST_ABORT_STOP_FAILED`，内容仅为有界、脱敏后的 `Error.name`/`message`。Desktop `observeHostExit` 走 `observeWebHostExit`：`smokeLog`（`appendFileSync`）抛错不能跳过 `onHostExit`。恢复通过 `Promise.resolve().then(onExit)` 调度，同步抛错不会拒绝 `exited`。观察者收住该失败并发出 `DSH_WEB_HOST_EXIT_RECOVERY_FAILED`，正文为固定文案，不含恢复 `Error` 文本。`formatWebHostExit` 仅在设置 `DSH_DESKTOP_SMOKE_FILE` 时写入，不是产品可读原因。`planHostExit` 不变。

Node fixture 覆盖就绪后 `_exit(1)`、主动 `stop` 与就绪后 abort。不启动 Electron，不启动设备。

## 考虑过的替代方案

**继续使用 `Promise<void>`，事后读 `child.exitCode`。** 拒绝，因为消费者可能在 `exit` 之后才挂接，且 `killed` 只表示已发信号，不表示进程已退出。

**把 PID 列表 SIGKILL 当作原生 containment。** 拒绝，因为标识复用与快照后启动的后代不被持有。该工作仍属 Issue #574，不属于本切片。

**用新记录改变 respawn 策略。** 拒绝，因为出处是诊断信息；恢复仍由窗口存活加一次 respawn 决定。

**交付把 flush 与 pending 切开再分别脱敏的流式采集器。** 拒绝。两侧拼接可能还原已知密钥。`WebHostExit` 省略子进程日志。就绪前错误仍使用一整段启动缓冲。

## 后果

运维可以区分非请求 Host 死亡与 `stop`/abort，且不改变 respawn。退出记录**没有**子进程日志：正在打印凭据时死亡的 Host 无法从 `WebHostExit` 还原。原生进程树清理**不在**本切片；记录的 PID 仍只是 wait(2) 事实。就绪前 `startupBuffer` 在 URL 宣布前**仍无界**，宣布后丢弃——这是既有行为，不是新的有界存储。`formatWebHostExit` 仅写入 smoke 文件；恢复不依赖它。
