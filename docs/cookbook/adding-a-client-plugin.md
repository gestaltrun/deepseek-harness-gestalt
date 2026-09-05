# Add a Web client plugin or component

English | [中文](adding-a-client-plugin.zh.md)

This tutorial covers the conditional scaffolding work for `packages/client/*`. Read the [Web client stack rules](../../packages/client/AGENTS.md) first; they own slot composition, props, layering, dependencies, styling, and test policy.

## Add a plugin package

1. Create `packages/client/<name>` with `package.json`, `tsconfig.json`, `tsdown.config.ts`, `src/index.ts`, `src/invariant.ts`, and `README.md`. A browser plugin also provides `src/client/`, the declared `./client` export, and `src/css-modules.d.ts` when it uses CSS Modules. Use `@deepseek-ai/dsh-client-<name>` and the package README's Model Experience section.
2. Register the package in `tsconfig.client.json`, add its `dsh.client` row to `packages/bundle/web-app/cordis.patch.yml`, and declare it in `packages/bundle/web-app/package.json`. All three are required: each missing surface fails at a different, later point — the `tsconfig.client.json` `references` entry at compile, the patch row at Loader composition, and the dependency at profile boot, where a bare row name resolves only through the healed flat `$DSH_HOME/profiles/node_modules` fallback that mirrors the app's and each bundle's declared dependencies, so a package no manifest declares fails to import.
3. Set `platform: 'web'`. Use `immediately: true` only for stage-one prefetch infrastructure. Treat `dsh.client.inject` as informational package edges; Cordis service injection controls activation, while a non-baseline `external` request controls synchronous module materialization.
4. For a contribution to another package's slot, use `ctx.slots.inject(name, () => ctx.slots.register(...))`. It waits for declaration and owns cleanup across redeclaration. Keep Cordis service edges only for services the contribution reads.
5. Decide the npm sections, `dsh.client.external` requests, browser and Node externality, and `files` coverage through the standing dependency and module-graph rules.
6. Rebuild the package bundle before a live probe because the registry serves `lib/client.js`.

Verify the owning package tests and `pnpm run test:gui`. Add `DSH_SNAPSHOT=replay pnpm run test:web` when the assembled browser or visible conversation output can change. A non-trivial decision includes an Agent Note.

## Add a component

1. Add the slot to `SlotMap`, declare it in the parent registration's `children`, and register the component.
2. Derive props from `PropsRuntime`, `PropsRenderSlots`, `PropsStore`, and the inject face. Put shared or remount-surviving interaction state in a registered store factory; keep component-private state local.
3. Test the component with direct realistic props and assert user-visible behavior without render machinery.
4. Use shared tokens through CSS Modules, Chinese product copy, and English code comments.

Verify `pnpm run test:gui`; add the replayed Web test when visible assembled output changes.
