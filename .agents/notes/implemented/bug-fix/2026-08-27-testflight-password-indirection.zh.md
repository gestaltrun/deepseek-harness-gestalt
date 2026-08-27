# Agent Note: 避免 TestFlight 密码进入进程参数

Status: implemented

[English](2026-08-27-testflight-password-indirection.md) | 中文

## Problem

将 App Store app-specific password 直接传给 `altool --password` 会把凭据值放入上传进程参数。即使工作流掩码了日志输出，进程列表和诊断采集仍可能保留该值。

## Decision

受保护的 `mobile-release` Environment 只向 TestFlight 上传步骤提供 `APPLE_APP_SPECIFIC_PASSWORD`。上传脚本把字面量选择器 `@env:APPLE_APP_SPECIFIC_PASSWORD` 传给 `altool`，由它从环境中读取凭据，而不把凭据值放入进程参数。调用上传器前，脚本仍会拒绝缺失的环境变量值。

## Alternatives considered

**将密码持久化到 Keychain 项。** 拒绝，因为工作流已经提供步骤级 secret，而持久化 Keychain 项会增加 runner 配置、轮换、清理和访问控制义务。

**从标准输入读取密码。** 拒绝，因为 `altool` 为非交互自动化提供了明确的环境变量选择器，而标准输入的所有权和失败行为在脚本中更不清晰。

**在此次修复中迁移到 App Store Connect API key。** 拒绝，因为 API key 认证会增加私钥文件以及独立的权限和轮换生命周期；它可以通过单独的发布身份决策引入。

## Consequences

进程参数只包含环境变量选择器，因此普通进程检查无法泄露密码值。上传器以及能够检查其环境的同用户进程仍可读取该凭据；本决策不声称具备主机级 secret 隔离能力。在此机制生效前被采集的密码必须在仓库之外撤销并替换。

## Testing

无密钥测试使用伪造的 `xcrun` 执行真实上传脚本，通过环境提供非敏感测试密码，并验证采集的进程参数只包含 `@env` 选择器且不包含密码值。
