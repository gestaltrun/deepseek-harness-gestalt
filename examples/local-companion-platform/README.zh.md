# 本地 Companion Platform

[English](README.md) | 中文

环回双实例 Platform：在一个 TLS origin 后挂载 Account HTTP、无密钥个人配对和 Relay WSS。[`apps/platform`](../../apps/platform/README.md) 的生产监听保持 fail-closed，且永不导入 `DevelopmentKeylessPairingHandshakeProvider`。

TLS 前端绑定 `127.0.0.1`，并使用捆绑的 [`two-instance-relay` localhost 证书](../two-instance-relay/fixtures/localhost-cert.pem)。`/v1/*` 与 `/v1/remote-access/relay` 在两个进程内实例间轮换，这些实例共享内存中的 Account、配对权威和 Relay 路由存储。该组成里的 GitHub 授权打开同一 origin 上的 `/v1/account/oauth/github/development-complete`，以 `octocat` 完成后再回到页面 origin，使 Desktop 与 Mobile 得到同一个 Platform Account。`LOCAL_COMPANION_PAGE_ORIGIN` 把其余路径反代到 Mobile Vite，让浏览上下文 origin 与受信任的 Platform origin 一致。

```sh
LOCAL_COMPANION_PORT=8443 LOCAL_COMPANION_PAGE_ORIGIN=http://127.0.0.1:5174 \
  node --import tsx/esm examples/local-companion-platform/tests/fixtures/listen-driver.ts
```

Mobile 选择 `VITE_PLATFORM_ENV=development`，设置 `VITE_PLATFORM_DEVELOPMENT_ORIGIN=https://127.0.0.1:8443`、匹配的回调以及互不相同的生产身份对，并打开 `VITE_PERSONAL_PAIRING_KEYLESS=1` 与 `VITE_REMOTE_RELAY_WSS_URL=wss://127.0.0.1:8443/v1/remote-access/relay` 及所需 Relay 边界。Desktop 在 `DSH_PLATFORM_*` 与 `DSH_PERSONAL_PAIRING_KEYLESS=1` 下使用同一组身份。能够出示环回证书的客户端打开 TLS origin。无法信任捆绑证书的 Android WebView 打开 `http://127.0.0.1` 上的 `LOCAL_COMPANION_PAGE_ORIGIN`；Mobile Vite 把 `/v1` 代理到监听，Mobile 入口再把 Account、配对、授权与 Relay 改写到该页面 origin。配对链接仍使用 HTTPS 监听 origin。

Loader 场景启动 [`cordis.yml`](cordis.yml)，证明同账号登录、默认关闭的手机访问、确认后的配对，以及一次加密 Relay 往返。它不是产品密码学实现。

## 已知限制与延后工作

- 该监听使用内存存储、未经评审的无密钥握手和捆绑测试证书。它不是已运营的生产 Platform。
- 原生 Capacitor 工程生成、APNs/FCM，以及 TestFlight 或签名 APK 打包仍在本示例之外。
