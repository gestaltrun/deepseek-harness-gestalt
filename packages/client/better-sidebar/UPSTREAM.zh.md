# 上游快照

[English](UPSTREAM.md) | 中文

本包是 [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的钉死源码快照。它不是 `vendor/` 下的 Cordis 包。

- 仓库：`https://github.com/omdsh-dev/DSH-better-sidebar.git`
- 分支：`main`
- 提交：`50a888845fc614f63dfbf4d2b3704cc1004cd5c0`
- 上游版本标签：`0.14.1`（`dsh.plugin.json`）
- 前缀：`packages/client/better-sidebar/`

更新：

```sh
git fetch https://github.com/omdsh-dev/DSH-better-sidebar.git main
git subtree pull --prefix=packages/client/better-sidebar \
  https://github.com/omdsh-dev/DSH-better-sidebar.git main
```

拉取后重放 [LOCAL-MODIFICATIONS.md](LOCAL-MODIFICATIONS.md) 中的每一条，更新本文件中的 SHA，并把产品行为留在 [`dsh-client-ui-workbench`](../ui-workbench/README.zh.md)。
