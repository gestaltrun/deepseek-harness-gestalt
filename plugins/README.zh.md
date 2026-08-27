# 外部插件

[English](README.md) | 中文

Gestalt 在本仓库旁开发的树外 DeepSeek Harness 插件，以 Git submodule 钉住精确修订。每个子目录是独立的 GitHub 仓库、npm 包和发布列车。本目录是修订目录，不是 pnpm workspace，也不是插件源码的副本。

`vendor/` 仍是树内 Cordis 源码的位置。`packages/` 仍是 `@deepseek-ai/dsh-*` workspace 的位置。Gestalt 作为一等 harness 包交付的插件仍属于 `packages/`。

## 目录

| 路径 | 仓库 | 职责 |
|---|---|---|
| [`dsh-sub2api-sidecar/`](https://github.com/gestaltrun/dsh-sub2api-sidecar) | [gestaltrun/dsh-sub2api-sidecar](https://github.com/gestaltrun/dsh-sub2api-sidecar) | 监督本机 Sub2API sidecar，并将其 Composite 端点登记为 Gestalt 提供方 |

## 克隆与更新

默认 `git clone` 只记录 submodule SHA，子目录在初始化前为空：

```sh
git submodule update --init --recursive
```

`git clone --recurse-submodules` 一次初始化全部子模块。需要插件源码的 CI checkout 在 `actions/checkout` 上设置 `submodules: recursive`。

在需要新修订的同一次变更中前移钉住的 SHA：

```sh
git -C plugins/dsh-sub2api-sidecar fetch origin
git -C plugins/dsh-sub2api-sidecar checkout <sha>
git add plugins/dsh-sub2api-sidecar
```

记录的 SHA 才是产品钉住点。浮动分支名不是。

## 约束

- 不要把目录子项加入 `pnpm-workspace.yaml`。
- 不要通过本仓库的 `tsconfig` paths 导入目录子项的 TypeScript。
- 不要从 Gestalt 提交改写 submodule 内部历史；先改子仓库，再移动钉住点。
- Desktop 启用来下载已构建的组合包和平台运行时包。submodule 是该工作的源码钉住点，不是安装载荷。
