# Agent Note: Localize plus-menu Phone title

Status: implemented

English | [中文](2026-09-04-phone-plus-menu-i18n.zh.md)

## Problem

The better-sidebar + menu and occupied Phone tab titles were hardcoded Chinese (`手机`, `手机·<name>`) in Node-safe `registry.ts`. English UI therefore showed Chinese on the Phone row. Issue #565.

## Decision

`registry.ts` stays Node-safe and does not import locale. `PHONE_TAB_TITLE` remains `'手机'` and `phoneTabTitleOf(name)` remains `` `手机·${name}` `` for Node invariant tests and direct helper calls. Live titles are functions on `PhoneTabOptions`: `title: () => string` and `occupiedTitle: (name: string) => string`. `buildPhoneTabDescriptor` assigns `title: options.title`. `createPhoneTabSwitcher`, `showPhonePicker`, `openPhoneDevicePanel`, and `installPhoneTab` take those functions; the browser path never uses `phoneTabTitleOf` for live titles.

Browser `apply()` registers `settings.phone-devices` then binds `t`. `title` is `() => t('tab')`. `occupiedTitle` is `(name) => `${t('occupied')}${name}``. Dictionaries: zh `tab: '手机'`, `occupied: '手机·'`; en `tab: 'Phone'`, `occupied: 'Phone · '` (spaces around the middle dot). Occupied English is `Phone · Pixel_6_API_35`.

`apply()` subscribes only to locale changes. Each notification reads the open singleton Phone tab from the current better-sidebar snapshot, parses its persisted `meta` through `phoneDeviceTabMetaOf`, and calls `updateTab` with only a localized `title`. Picker or invalid device meta resolves through `title()`; occupied meta resolves through `occupiedTitle(meta.name)`. The tab remains mounted and its `meta` reference is not rewritten.

## Alternatives considered

**Import locale into `registry.ts`.** Rejected: the Node invariant companion imports that module and must stay JSX/locale-free.

**Interpolation templates `手机·{name}` / `Phone · {name}` as the occupied key.** Rejected: apply concatenates the prefix so the binder need not interpolate, and zh has no spaces around `·`.

**Function values in the locale `Record<string, string>`.** Rejected: dictionaries stay string maps.

## Consequences

Default zh still shows 手机. English + menu and picker titles show Phone; occupied titles show `Phone · <name>`. Desktop overlay fixtures may keep a fake `手机` label. Remaining picker and connection copy stays Chinese.

## Related

Descriptor registration remains [the tab skeleton](../architecture/2026-08-27-ui-phone-tab-skeleton.md). Picker return remains [sidebar live listing](2026-09-04-ui-phone-sidebar-picker-live-listing.md).
