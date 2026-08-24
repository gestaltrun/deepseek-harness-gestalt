# Agent Note: pwsh 命令后就绪

Status: implemented

[English](2026-08-24-pwsh-post-command-readiness.md) | 中文

## 问题

由 profile 拥有的 pwsh stdin 循环可能在 terminal 写入后、消费提交行前，立即报告 shell 进程组正在 `ReadLine` 中等待。在高负载下，精确 stdin-wait 档可能只带着命令回显就结算 send，使命令输出不再进入该 operation result。

## 决策

pwsh shell 进程组通过自有的命令后提示符，或有界静默与超时档结算。当 pwsh 把 terminal 交给另一个前台进程组时，提供方报告的 stdin wait 仍是精确就绪证据，从而保留交互式子进程行为。Bash 继续使用现有 stdin-wait 规则。

## 考虑过的替代方案

**增加真实 shell 测试超时。** 否决，因为 operation 已经结算；延长断言时间无法恢复不再属于该 send 的输出。

**对所有 pwsh 前台禁用精确 stdin wait。** 否决，因为发生变化的前台进程组是属于当前 generation 的交互式子进程证据。

**把命令回显视为输出。** 否决，因为回显只能证明 terminal 收到了字节，不能证明 pwsh 执行了该行或产生了结果。

## 后果

pwsh shell 进程组中的命令无法在命令后提示符之前结算。其他进程组中的交互式子进程保留精确 stdin-wait 就绪；marker 丢失时仍退化到现有有界静默档。

## 测试

Session 测试复现回显输入后的同组过早 stdin wait，并要求自有提示符出现后才结算。配套用例验证发生变化的 pwsh 前台进程组仍能精确就绪。真实 pwsh UTF-8 测试继续作为 Linux CI 上的进程级回归。
