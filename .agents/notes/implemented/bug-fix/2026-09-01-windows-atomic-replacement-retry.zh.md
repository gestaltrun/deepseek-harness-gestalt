# Agent Note: Retry Transient Windows Atomic Replacements

Status: implemented

[English](2026-09-01-windows-atomic-replacement-retry.md) | 中文

## Problem

当扫描器或其他进程仍持有句柄时，Windows 可能暂时拒绝替换已有文件。带随机后缀的完整临时文件仍然有效，但在第一次 `rename` 失败时就返回，会把稍后即可替换目标的持久存储提交报告为失败。

## Decision

`writeFileAtomic` 只在 Windows 上、且只对 `EPERM`、`EACCES` 与 `EBUSY` 重试 `rename`。它在固定等待 10、20、40、80 与 160 毫秒后复用同一个已经写完的同目录临时文件，因此仍然只有一个原子提交点，并保留调用方声明的 mode。

其他错误和平台全部立即失败。310 毫秒的重试窗口耗尽后，原语会移除临时文件并重新抛出最后一次文件系统错误；持续的权限失败不会被重新解释为竞争。

## Alternatives considered

**在每个持久存储调用方重试。** 调用方级重试会重复文件系统策略，还可能重复加密、渲染或外围状态变更。原子替换原语拥有可安全重复的精确操作。

**在所有平台上重试每一种 rename 失败。** 无效目标层级等结构性错误不会因等待而变为有效。把重试限制在已经观察到的 Windows 访问错误族，可以让无关失败保持立即可见。

**要求每个已渲染提交都由 `withFileLock` 包裹。** 读-改-写循环必须使用写入锁，但相互独立的完整替换可以在原子提交点安全竞争。强制加锁会增加超时与遗留锁恢复行为，却不能消除扫描器的瞬时句柄。

## Consequences

持续的 Windows 访问失败最多延后 310 毫秒到达调用方。成功替换、符号链接目标替换、权限收窄、锁语义和非 Windows 失败时序均保持不变。

## Testing

atomic-write 测试会在成功前注入三种瞬时 Windows 错误，耗尽有界重试次数，验证非 Windows 立即失败，并检查目标内容与临时文件清理。Desktop account store 的并发用例会经过原始的完整记录替换路径。Issue [#507](https://github.com/gestaltrun/deepseek-harness-gestalt/issues/507) 负责该修复。
