# @deepseek-ai/dsh-phone-capture-wire-demo

[English](README.md) | 中文

只包含 bin 的应用，启动外部 `cordis.yml`，用于无密钥 Android 采集源 Host 线。叶子配置拥有 host-webserver、phone-runtime 与 phone-stream。`pnpm run build` 从 `src/bin.ts` 发出 `lib/bin.js`；`DSH_EXAMPLE_MODE=lib` 在纯 Node 下启动该产物。

## 配置发现

位置参数 `argv[2]` 必填。缺失时 bin 抛错退出；没有工作目录回退。[`dsh-app-boot`](../../boot/app-boot/README.zh.md) 会使插件加载失败成为致命错误。

## 退出生命周期

场景插件写出投影后的 transcript 后，bin dispose 根 fiber 并退出。

## stdout 是 transcript

stdout 只承载场景 JSON 行。bin 和启动守卫在 stderr 上输出诊断。

## 模型体验

### 无密钥脚本化转录

#### 模型看到的内容

仓库提供的 [`phone-capture-wire` 组合](../../../examples/phone-capture-wire/cordis.yml) 不调用模型。场景插件驱动手机操作，并向 `stdout` 写出 JSON 转录；该转录是测试输出，不是模型上下文。bin 加载传入的 `cordis.yml`，因此其他组合需对其引入的任何模型调用负责。

#### Token 影响

仓库提供的脚本化组合不发送模型请求，也不消耗模型输入或输出 token。其 JSON 转录不是模型运行的证据。

#### KV Cache 影响

仓库提供的脚本化组合不创建模型请求前缀，也不使用提供方的 KV Cache。

## 已知限制与延后工作

- **bin 不组合 phone 插件** — 每次启动都必须提供一份点名 host-webserver、phone-runtime 与 phone-stream 的叶子 `cordis.yml`。
- **lib mode 需要已声明构建** — `lib/bin.js` 是 gitignore 产物；干净检出后用 `pnpm run build` 重新生成。
