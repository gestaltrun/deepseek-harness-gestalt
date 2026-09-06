# IM 接管已认可原型

[English](README.md) | 中文

已认可 IM 接管设计的自包含 React/Vite 原型。全部运行于内存演示数据：无真实 IM 连接、无真实认证、不保存凭据。

## 运行

前置条件：`prototype/package.json` 中 `file:` 依赖（`@deepseek-ai/dsh-client-ui-primitives`）指向的正式应用 checkout 必须存在于该绝对路径，或把该路径改成本机等价位置。本原型不可移植到没有该应用安装的机器。

```sh
cd .agents/design/im-takeover/prototype
npm install    # first run generates a local package-lock.json for this location
npm run dev    # http://127.0.0.1:5174/
```

不提交锁文件：npm 会把 `file:` 链接按 checkout 目录深度转成相对路径，提交的锁文件在归档被复制到其他位置后会失效。使用 `npm install`，不要用 `npm ci`。`npm run build` 验证打包可编译。

## 来源

正式 UI 基础组件直接引用自已安装应用；主题 token 快照在 `system/tokens/`，来源哈希见 `manifest.json`。外壳按正式截图有据重建并在 `manifest.json` 标明，不宣称逐像素一致。`HASHES.sha256` 校验本归档 sanitize 后的实际文件集；正式 GUI 私人参考截图被刻意排除。
