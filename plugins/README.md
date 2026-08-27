# External plugins

English | [中文](README.zh.md)

Pinned Git submodules of out-of-tree DeepSeek Harness plugins that Gestalt develops beside this repository. Each child is its own GitHub repository, npm package, and release train. This directory is a catalog of exact revisions, not a pnpm workspace and not a copy of plugin source.

`vendor/` remains the home of in-tree Cordis source. `packages/` remains the home of `@deepseek-ai/dsh-*` workspaces. A plugin that Gestalt ships as a first-party harness package still belongs under `packages/`.

## Catalog

| Path | Repository | Role |
|---|---|---|
| [`dsh-sub2api-sidecar/`](https://github.com/gestaltrun/dsh-sub2api-sidecar) | [gestaltrun/dsh-sub2api-sidecar](https://github.com/gestaltrun/dsh-sub2api-sidecar) | Supervises a local Sub2API sidecar and registers its Composite endpoint as a Gestalt provider |

## Clone and update

A default `git clone` records the submodule SHA and leaves an empty directory until the child is initialized:

```sh
git submodule update --init --recursive
```

`git clone --recurse-submodules` initializes every child in one step. CI checkouts that need plugin source set `submodules: recursive` on `actions/checkout`.

Advance a pin in the same change that needs the new revision:

```sh
git -C plugins/dsh-sub2api-sidecar fetch origin
git -C plugins/dsh-sub2api-sidecar checkout <sha>
git add plugins/dsh-sub2api-sidecar
```

The recorded SHA is the product pin. A floating branch name is not.

## Constraints

- Do not add a catalog child to `pnpm-workspace.yaml`.
- Do not import a catalog child's TypeScript through this repository's `tsconfig` paths.
- Do not rewrite history inside a submodule from a Gestalt commit; change the child repository, then move the pin.
- Desktop enablement downloads a built bundle and a platform runtime pack. The submodule is the source pin for that work, not the install payload.
