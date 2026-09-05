# 添加 Web 客户端插件或组件

[English](adding-a-client-plugin.md) | 中文

本教程覆盖 `packages/client/*` 的条件式脚手架流程。先阅读 [Web 客户端栈规则](../../packages/client/AGENTS.md)；slot 组合、props、分层、依赖、样式和测试政策由该文件管理。

## 添加插件包

1. 创建 `packages/client/<name>`，包含 `package.json`、`tsconfig.json`、`tsdown.config.ts`、`src/index.ts`、`src/invariant.ts` 和 `README.md`。浏览器插件还提供 `src/client/`、声明的 `./client` export，以及使用 CSS Modules 时的 `src/css-modules.d.ts`。包名使用 `@deepseek-ai/dsh-client-<name>`，README 包含 Model Experience 部分。
2. 在 `tsconfig.client.json` 注册包，在 `packages/bundle/web-app/cordis.patch.yml` 添加 `dsh.client` 行，并在 `packages/bundle/web-app/package.json` 声明依赖。三项缺一不可：每个缺失面会在不同的后续阶段失败——`tsconfig.client.json` 的 `references` 项在编译时失败，patch 行在 Loader 组合时失败，依赖在 profile 启动时失败；此时裸行名只能经修复后的扁平 `$DSH_HOME/profiles/node_modules` 回退目录解析，该目录镜像应用与各 bundle 声明的依赖，没有任何 manifest 声明的包会 import 失败。
3. 设置 `platform: 'web'`。只有 stage-one 预取基础设施使用 `immediately: true`。`dsh.client.inject` 是信息性包边；Cordis service injection 控制激活，非 baseline 的 `external` 请求控制同步模块物化。
4. 向其他包的 slot 贡献内容时，使用 `ctx.slots.inject(name, () => ctx.slots.register(...))`。它等待声明，并在重新声明过程中管理清理。只为贡献实际读取的 service 保留 Cordis service 边。
5. 按常驻依赖与模块图规则决定 npm sections、`dsh.client.external` 请求、浏览器和 Node externality，以及 `files` 覆盖。
6. 实机探测前重建包 bundle，因为 registry 服务的是 `lib/client.js`。

验证 owner 包测试与 `pnpm run test:gui`。可能改变组装浏览器或可见对话输出时，再运行 `DSH_SNAPSHOT=replay pnpm run test:web`。非平凡决策包含 Agent Note。

## 添加组件

1. 把 slot 加入 `SlotMap`，在父注册的 `children` 中声明，再注册组件。
2. 从 `PropsRuntime`、`PropsRenderSlots`、`PropsStore` 与 inject face 派生 props。共享或跨 remount 保留的交互状态放入已注册 store factory，组件私有状态保持本地。
3. 用直接、真实的 props 测试组件，在不引入 render machinery 的情况下断言用户可见行为。
4. 通过 CSS Modules 使用共享 token；产品文案使用中文，代码注释使用英文。

验证 `pnpm run test:gui`；可见组装输出改变时增加 replayed Web 测试。
