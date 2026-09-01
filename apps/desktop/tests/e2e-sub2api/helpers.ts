/** Black-box helpers for the built Desktop Host Sub2API journey. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { browser } from '@wdio/globals'
import type {} from '@wdio/native-types'
import { load } from 'js-yaml'
import { isExpectedSessionSurface } from './session-surface.ts'

const ADMIN_PREFIX = '/plugins/dsh-sub2api/admin'
const REAL_PROVIDER_CREDENTIAL_REF = 'ZAI_CODING_CN_API_KEY'
const SUB2API_PUBLIC_MODEL = 'claude-sonnet-4-5-20250929'
export const ACCOUNT_PROVIDER_MODEL = 'claude-fable-5'
const execFileAsync = promisify(execFile)

interface Sub2ApiSnapshot {
  readonly state: 'missing' | 'downloading' | 'verifying' | 'installed' | 'starting' | 'running' | 'error'
  readonly enabled: boolean
  readonly version?: string
  readonly error?: string
}

export interface MainWindowSnapshot {
  readonly url: string
  readonly text: string
}

export interface AccountWorkspaceLayoutSnapshot {
  readonly borderTopWidth: string
  readonly frameHeight: number
  readonly contentHeight: number
  readonly settingsOverflowY: string | undefined
  readonly tableClientHeight: number | undefined
  readonly tableScrollHeight: number | undefined
}

export interface AccountDialogSnapshot {
  readonly text: string
  readonly zIndex: string
  readonly ownsCenter: boolean
}

export interface AccountWorkspaceUiSnapshot {
  readonly text: string
  readonly headers: readonly string[]
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

/** Focus the Session Surface rather than the Desktop overlay document. */
export async function switchToSessionSurface(expectedUrl?: string): Promise<void> {
  const handles = await browser.getWindowHandles()
  for (const handle of handles) {
    await browser.switchToWindow(handle)
    const candidate = await browser.execute(() => ({
      overlay: document.documentElement.hasAttribute('data-dsh-desktop-overlay'),
      url: location.href,
    }))
    if (isExpectedSessionSurface(candidate, expectedUrl)) return
  }
  throw new Error('Desktop Host exposed no Session Surface window')
}

/** Focus the native Desktop overlay through its WebDriver window handle. */
async function switchToDesktopOverlay(): Promise<void> {
  const handles = await browser.getWindowHandles()
  for (const handle of handles) {
    await browser.switchToWindow(handle)
    const overlay = await browser.execute(() =>
      document.documentElement.hasAttribute('data-dsh-desktop-overlay'))
    if (overlay) return
  }
  throw new Error('Desktop Host exposed no overlay WebContentsView')
}

/** Wait for the built client runtime to paint the real Desktop Session Surface. */
export async function waitForSessionSurface(expectedUrl?: string): Promise<void> {
  await switchToSessionSurface(expectedUrl)
  await browser.waitUntil(async () => {
    const url = await browser.getUrl()
    const rendered = await browser.execute(() => document.body?.innerText.length > 0)
    return (expectedUrl === undefined
      ? /^http:\/\/127\.0\.0\.1:\d+\//u.test(url)
      : new URL(url).href === new URL(expectedUrl).href) && rendered
  }, { timeout: 120_000, timeoutMsg: 'Desktop Session Surface did not render' })
  for (let step = 0; step < 3; step += 1) {
    let completed = false
    for (const label of ['继续', 'Continue', '稍后配置', 'Configure later']) {
      const action = browser.$(`button=${label}`)
      if (await action.isExisting()) {
        await action.click()
        await browser.pause(250)
        completed = true
        break
      }
    }
    if (!completed) break
  }
}

/** Save the two public checksum documents through Electron's tested network stack. */
export async function recordReleaseChecksums(): Promise<void> {
  const sources = JSON.parse(await readFile(requiredEnv('DSH_DESKTOP_SUB2API_SOURCES'), 'utf8')) as {
    bundleUrl: string
    bundleSha256SumsUrl: string
    runtimePackUrl: string
    runtimePackSha256SumsUrl: string
  }
  const assetPattern = /^https:\/\/github\.com\/gestaltrun\/dsh-sub2api-sidecar\/releases\/download\/([^/]+)\/([^/]+)$/u
  const assets = [
    sources.bundleUrl,
    sources.bundleSha256SumsUrl,
    sources.runtimePackUrl,
    sources.runtimePackSha256SumsUrl,
  ].map((url) => {
    const match = assetPattern.exec(url)
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error('Sub2API source URL is not an official GitHub Release asset')
    }
    return { tag: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]) }
  })
  const tag = assets[0]?.tag
  if (tag === undefined || assets.some(asset => asset.tag !== tag)) {
    throw new Error('Sub2API source URLs do not belong to one Release tag')
  }
  const version = /^v(.+)$/u.exec(tag)?.[1]
  if (version === undefined
    || assets[0]?.name !== `dsh-sub2api-sidecar-${version}.tgz`
    || assets[1]?.name !== 'bundle-sha256sums.txt'
    || !/^runtime-pack-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-(?:darwin|linux|win32)-(?:arm64|x64)\.tar\.gz$/u.test(assets[2]?.name ?? '')
    || assets[3]?.name !== 'runtime-pack-sha256sums.txt') {
    throw new Error('Sub2API Release has unexpected asset names')
  }
  const result = await browser.electron.execute(async (electron, input) => {
    const values: string[] = []
    for (const url of input.checksumUrls) {
      const response = await electron.net.fetch(url)
      if (!response.ok) throw new Error(`checksum download failed: HTTP ${String(response.status)}`)
      const body = await response.text()
      if (Buffer.byteLength(body) > 64 * 1024) throw new Error('checksum response exceeds 64 KiB')
      values.push(body)
    }
    const headers = { 'user-agent': 'deepseek-harness-electron-e2e' }
    const refResponse = await electron.net.fetch(
      `https://api.github.com/repos/gestaltrun/dsh-sub2api-sidecar/git/ref/tags/${encodeURIComponent(input.tag)}`,
      { headers },
    )
    if (!refResponse.ok) throw new Error(`release tag lookup failed: HTTP ${String(refResponse.status)}`)
    const ref = await refResponse.json() as { object?: { type?: string; sha?: string; url?: string } }
    let commit = ref.object?.sha
    if (ref.object?.type === 'tag' && ref.object.url !== undefined) {
      const tagResponse = await electron.net.fetch(ref.object.url, { headers })
      if (!tagResponse.ok) throw new Error(`annotated tag lookup failed: HTTP ${String(tagResponse.status)}`)
      const tag = await tagResponse.json() as { object?: { type?: string; sha?: string } }
      if (tag.object?.type !== 'commit') throw new Error('release tag does not resolve to a commit')
      commit = tag.object.sha
    } else if (ref.object?.type !== 'commit') {
      throw new Error('release ref does not resolve to a commit')
    }
    return { documents: values, commit, tag: input.tag }
  }, {
    checksumUrls: [sources.bundleSha256SumsUrl, sources.runtimePackSha256SumsUrl],
    tag,
  })
  const expectedSidecar = requiredEnv('DSH_SUB2API_E2E_SIDECAR_SHA')
  if (result.commit !== expectedSidecar) throw new Error('sidecar Release tag does not match DSH_SUB2API_E2E_SIDECAR_SHA')
  const artifactDir = requiredEnv('DSH_SUB2API_E2E_ARTIFACT_DIR')
  await writeFile(join(artifactDir, 'bundle-sha256sums.txt'), result.documents[0] ?? '')
  await writeFile(join(artifactDir, 'runtime-pack-sha256sums.txt'), result.documents[1] ?? '')
  await writeFile(join(artifactDir, 'sidecar-release.json'), JSON.stringify({
    repository: 'gestaltrun/dsh-sub2api-sidecar',
    tag: result.tag,
    commit: result.commit,
    assets: assets.map(asset => asset.name),
  }, undefined, 2) + '\n')
}

/** Open Settings through the visible Desktop sidebar control. */
export async function openSettings(): Promise<void> {
  await switchToSessionSurface()
  const trigger = browser.$('button[aria-haspopup="dialog"]')
  await trigger.waitForClickable({ timeout: 30_000 })
  await trigger.click()
  await browser.waitUntil(async () => {
    try {
      await switchToDesktopOverlay()
      return await browser.execute(() => {
        const text = document.body?.innerText ?? ''
        return text.includes('设置') || text.includes('Settings')
      })
    } catch {
      return false
    }
  }, { timeout: 30_000, timeoutMsg: 'Desktop Settings overlay did not open' })
}

/** Click a visible button in the native Desktop overlay by bilingual label. */
export async function clickOverlayButton(labels: readonly string[]): Promise<void> {
  await switchToDesktopOverlay()
  const clicked = await browser.execute((buttonLabels: readonly string[]) => {
    const button = [...document.querySelectorAll('button')].find(element =>
      buttonLabels.some(label => element.textContent?.includes(label)))
    if (button === undefined) return false
    button.click()
    return true
  }, labels)
  if (!clicked) throw new Error(`Desktop overlay has no button matching ${labels.join(' / ')}`)
}

/** Return the visible text from the native Desktop overlay. */
export async function overlayText(): Promise<string> {
  await switchToDesktopOverlay()
  return await browser.execute(() => document.body?.innerText ?? '')
}

/** Return the current overlay document URL after a Web Host replacement. */
export async function overlayUrl(): Promise<string> {
  await switchToDesktopOverlay()
  return await browser.getUrl()
}

/** Read the same-origin account console embedded inside the Settings overlay. */
export async function overlayAccountConsoleSnapshot(): Promise<MainWindowSnapshot> {
  await switchToDesktopOverlay()
  return await browser.execute(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="/plugins/dsh-sub2api/ui/admin/accounts?"]')
    if (frame === null || frame.contentWindow === null || frame.contentDocument === null) return { url: '', text: '' }
    return {
      url: frame.contentWindow.location.href,
      text: frame.contentDocument.body?.innerText ?? '',
    }
  })
}

/** Read the visible account table contract from the embedded native workspace. */
export async function overlayAccountWorkspaceUi(): Promise<AccountWorkspaceUiSnapshot> {
  await switchToDesktopOverlay()
  return await browser.execute(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="/plugins/dsh-sub2api/ui/admin/accounts?"]')
    const content = frame?.contentDocument
    if (content === null || content === undefined) return { text: '', headers: [] }
    return {
      text: content.body?.innerText ?? '',
      headers: [...content.querySelectorAll<HTMLTableCellElement>('thead th')]
        .map(header => header.innerText.trim())
        .filter(header => header.length > 0),
    }
  })
}

/** Open one provider editor in Models Settings by its visible identity. */
export async function openProviderEditor(providerLabels: readonly string[]): Promise<void> {
  await switchToDesktopOverlay()
  const clicked = await browser.execute((labels: readonly string[]) => {
    const row = [...document.querySelectorAll<HTMLElement>('li')].find(element =>
      labels.some(label => element.textContent?.includes(label)))
    const button = [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(element =>
      /编辑|Edit/u.test(element.textContent ?? ''))
    if (button === undefined) return false
    button.click()
    return true
  }, providerLabels)
  if (!clicked) throw new Error(`Models Settings has no provider editor matching ${providerLabels.join(' / ')}`)
}

/** Expand the customized settings owned by the open provider editor. */
export async function expandProviderSettings(labels: readonly string[]): Promise<void> {
  await switchToDesktopOverlay()
  const clicked = await browser.execute((summaryLabels: readonly string[]) => {
    const summary = [...document.querySelectorAll<HTMLElement>('details summary')].find(element =>
      summaryLabels.some(label => element.textContent?.includes(label)))
    if (summary === undefined) return false
    summary.click()
    return true
  }, labels)
  if (!clicked) throw new Error(`Models Settings has no customized section matching ${labels.join(' / ')}`)
}

/** Read input values rendered by the currently open provider editor. */
export async function overlayProviderInputValues(): Promise<readonly string[]> {
  await switchToDesktopOverlay()
  return await browser.execute(() => [...document.querySelectorAll<HTMLInputElement>('details[open] input')]
    .map(input => input.value)
    .filter(value => value.length > 0))
}

/** Read the iframe and scroll ownership at the public Settings/account-workspace seam. */
export async function overlayAccountWorkspaceLayout(): Promise<AccountWorkspaceLayoutSnapshot> {
  await switchToDesktopOverlay()
  return await browser.execute(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="/plugins/dsh-sub2api/ui/admin/accounts?"]')
    if (frame === null || frame.contentDocument === null) {
      return {
        borderTopWidth: '', frameHeight: 0, contentHeight: 0,
        settingsOverflowY: undefined, tableClientHeight: undefined, tableScrollHeight: undefined,
      }
    }
    let settingsOverflowY: string | undefined
    let ancestor = frame.parentElement
    while (ancestor !== null) {
      const overflow = getComputedStyle(ancestor).overflowY
      if (overflow === 'auto' || overflow === 'scroll') {
        settingsOverflowY = overflow
        break
      }
      ancestor = ancestor.parentElement
    }
    const table = frame.contentDocument.querySelector<HTMLElement>('.table-wrapper')
    return {
      borderTopWidth: getComputedStyle(frame).borderTopWidth,
      frameHeight: frame.getBoundingClientRect().height,
      contentHeight: frame.contentDocument.documentElement.scrollHeight,
      settingsOverflowY,
      tableClientHeight: table?.clientHeight,
      tableScrollHeight: table?.scrollHeight,
    }
  })
}

/** Read visible native-dialog stacking and which dialog owns the viewport center. */
export async function overlayAccountDialogStack(): Promise<readonly AccountDialogSnapshot[]> {
  await switchToDesktopOverlay()
  return await browser.execute(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="/plugins/dsh-sub2api/ui/admin/accounts?"]')
    const content = frame?.contentDocument
    const contentWindow = frame?.contentWindow
    if (content === null || content === undefined || contentWindow === null || contentWindow === undefined) return []
    const center = content.elementFromPoint(contentWindow.innerWidth / 2, contentWindow.innerHeight / 2)
    return [...content.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .filter((dialog) => {
        const style = getComputedStyle(dialog)
        return dialog.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      })
      .map(dialog => ({
        text: dialog.textContent?.trim().slice(0, 160) ?? '',
        zIndex: getComputedStyle(dialog).zIndex,
        ownsCenter: center !== null && dialog.contains(center),
      }))
  })
}

/** Click a bilingual button inside the native Sub2API account workspace. */
export async function clickAccountConsoleButton(labels: readonly string[]): Promise<void> {
  await switchToDesktopOverlay()
  const clicked = await browser.execute((buttonLabels: readonly string[]) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="/plugins/dsh-sub2api/ui/admin/accounts?"]')
    const button = [...(frame?.contentDocument?.querySelectorAll('button') ?? [])].find(element =>
      buttonLabels.some(label => element.textContent?.includes(label)))
    if (button === undefined) return false
    button.click()
    return true
  }, labels)
  if (!clicked) throw new Error(`Sub2API account workspace has no button matching ${labels.join(' / ')}`)
}

/** Click a bilingual button in the topmost visible native account-workspace dialog. */
export async function clickTopAccountDialogButton(labels: readonly string[]): Promise<void> {
  await switchToDesktopOverlay()
  const clicked = await browser.execute((buttonLabels: readonly string[]) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="/plugins/dsh-sub2api/ui/admin/accounts?"]')
    const content = frame?.contentDocument
    if (content === null || content === undefined) return false
    const dialogs = [...content.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .filter((dialog) => {
        const style = getComputedStyle(dialog)
        return dialog.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      })
      .sort((left, right) => Number.parseInt(getComputedStyle(left).zIndex || '0', 10)
        - Number.parseInt(getComputedStyle(right).zIndex || '0', 10))
    const top = dialogs.at(-1)
    const button = [...(top?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(element =>
      element.offsetParent !== null && buttonLabels.some(label => element.textContent?.includes(label)))
    if (button === undefined) return false
    button.click()
    return true
  }, labels)
  if (!clicked) throw new Error(`Top Sub2API dialog has no button matching ${labels.join(' / ')}`)
}

/** Fill one labelled input in the topmost visible native account-workspace dialog. */
export async function fillTopAccountDialogInput(labels: readonly string[], value: string): Promise<void> {
  await switchToDesktopOverlay()
  const filled = await browser.execute((fieldLabels: readonly string[], nextValue: string) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="/plugins/dsh-sub2api/ui/admin/accounts?"]')
    const content = frame?.contentDocument
    if (content === null || content === undefined) return false
    const dialogs = [...content.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .filter((dialog) => {
        const style = getComputedStyle(dialog)
        return dialog.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      })
      .sort((left, right) => Number.parseInt(getComputedStyle(left).zIndex || '0', 10)
        - Number.parseInt(getComputedStyle(right).zIndex || '0', 10))
    const top = dialogs.at(-1)
    const label = [...(top?.querySelectorAll<HTMLLabelElement>('label') ?? [])]
      .find(element => fieldLabels.some(text => element.textContent?.includes(text)))
    const input = label?.parentElement?.querySelector<HTMLInputElement>('input')
    if (input === null || input === undefined) return false
    input.value = nextValue
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, labels, value)
  if (!filled) throw new Error(`Top Sub2API dialog has no input matching ${labels.join(' / ')}`)
}

/** Click one row action in the native proxy table by proxy identity and bilingual action label. */
export async function clickAccountConsoleRowAction(
  rowIdentity: string,
  labels: readonly string[],
): Promise<void> {
  await switchToDesktopOverlay()
  const clicked = await browser.execute((identity: string, actionLabels: readonly string[]) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="/plugins/dsh-sub2api/ui/admin/accounts?"]')
    const rows = [...(frame?.contentDocument?.querySelectorAll<HTMLTableRowElement>('tbody tr') ?? [])]
    const row = rows.find(candidate => candidate.textContent?.includes(identity))
    const button = [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      .find(candidate => actionLabels.some(label => candidate.textContent?.includes(label)))
    if (button === undefined) return false
    button.click()
    return true
  }, rowIdentity, labels)
  if (!clicked) {
    throw new Error(`Sub2API proxy row ${rowIdentity} has no action matching ${labels.join(' / ')}`)
  }
}

/** Read currently visible options from the native account form's open select. */
export async function overlayAccountSelectOptions(): Promise<readonly string[]> {
  await switchToDesktopOverlay()
  return await browser.execute(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="/plugins/dsh-sub2api/ui/admin/accounts?"]')
    return [...(frame?.contentDocument?.querySelectorAll<HTMLElement>('.select-option') ?? [])]
      .filter(element => element.offsetParent !== null)
      .map(element => element.textContent?.trim() ?? '')
      .filter(text => text.length > 0)
  })
}

/** Click one structural control inside the native Sub2API account workspace. */
export async function clickAccountConsoleSelector(selector: string): Promise<void> {
  await switchToDesktopOverlay()
  const clicked = await browser.execute((target: string) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="/plugins/dsh-sub2api/ui/admin/accounts?"]')
    const element = frame?.contentDocument?.querySelector<HTMLElement>(target)
    if (element === null || element === undefined) return false
    element.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`Sub2API account workspace has no element matching ${selector}`)
}

/** Click one option in a native Sub2API select dropdown by visible label. */
export async function clickAccountConsoleOption(labels: readonly string[]): Promise<void> {
  await switchToDesktopOverlay()
  const clicked = await browser.execute((optionLabels: readonly string[]) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="/plugins/dsh-sub2api/ui/admin/accounts?"]')
    const option = [...(frame?.contentDocument?.querySelectorAll<HTMLElement>('.select-option') ?? [])]
      .find(element => optionLabels.some(label => element.textContent?.includes(label)))
    if (option === undefined) return false
    option.click()
    return true
  }, labels)
  if (!clicked) throw new Error(`Sub2API account workspace has no select option matching ${labels.join(' / ')}`)
}

/** Click the select trigger belonging to a labelled native Sub2API field. */
export async function clickAccountConsoleFieldSelector(labels: readonly string[]): Promise<void> {
  await switchToDesktopOverlay()
  const clicked = await browser.execute((fieldLabels: readonly string[]) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[src^="/plugins/dsh-sub2api/ui/admin/accounts?"]')
    const label = [...(frame?.contentDocument?.querySelectorAll<HTMLElement>('label') ?? [])]
      .find(element => fieldLabels.some(text => element.textContent?.includes(text)))
    let container = label?.parentElement
    while (container !== null && container !== undefined) {
      const trigger = container.querySelector<HTMLElement>('.select-trigger')
      if (trigger !== null) {
        trigger.click()
        return true
      }
      container = container.parentElement
    }
    return false
  }, labels)
  if (!clicked) throw new Error(`Sub2API account workspace has no select field matching ${labels.join(' / ')}`)
}

/** Read Sub2API state through the same isolated preload bridge used by the UI. */
export async function sub2apiSnapshot(): Promise<Sub2ApiSnapshot | undefined> {
  await switchToDesktopOverlay()
  return await browser.execute(async () => {
    const desktopWindow = window as typeof window & {
      dshDesktop?: { sub2ApiGetSnapshot: () => Promise<Sub2ApiSnapshot> }
    }
    return await desktopWindow.dshDesktop?.sub2ApiGetSnapshot()
  })
}

/** Read the one product BrowserWindow rather than an overlay CDP target. */
export async function mainWindowSnapshot(): Promise<MainWindowSnapshot> {
  return await browser.electron.execute(async (electron) => {
    const window = electron.BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
    if (window === undefined) return { url: '', text: '' }
    return {
      url: window.webContents.getURL(),
      text: await window.webContents.executeJavaScript('document.body?.innerText ?? ""') as string,
    }
  })
}

/** Configure one temporary Z.AI account and point the published model route at it. */
export async function configureRealModelRoute(hostOrigin: string): Promise<void> {
  const credentials = load(await readFile(join(requiredEnv('DSH_HOME'), '.credentials.yaml'), 'utf8'))
  const refs = record(credentials)?.['refs']
  const apiKey = record(refs)?.[REAL_PROVIDER_CREDENTIAL_REF]
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error(`E2E credentials have no ${REAL_PROVIDER_CREDENTIAL_REF}`)
  }
  const groups = await adminJson<{ items?: Array<{ id: number; platform: string }> }>(
    hostOrigin,
    '/groups?page=1&page_size=100',
  )
  const composite = groups.items?.find(group => group.platform === 'composite')
  if (composite === undefined) throw new Error('Sub2API E2E found no composite group')
  await adminJson(hostOrigin, '/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'dsh-electron-e2e-zai',
      platform: 'zhipu',
      type: 'apikey',
      credentials: {
        base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
        api_key: apiKey,
        account_mode: 'coding',
        api_protocol: 'chat_completions',
      },
      group_ids: [composite.id],
      concurrency: 1,
      priority: 100,
      rate_multiplier: 1,
      upstream_billing_probe_enabled: false,
    }),
  })
  const routes = await adminJson<Array<{ id: number; public_model: string }>>(
    hostOrigin,
    `/groups/${String(composite.id)}/composite-routes`,
  )
  const route = routes.find(entry => entry.public_model === SUB2API_PUBLIC_MODEL)
  const routePath = `/groups/${String(composite.id)}/composite-routes`
    + (route === undefined ? '' : `/${String(route.id)}`)
  await adminJson(hostOrigin, routePath, {
    method: route === undefined ? 'POST' : 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      public_model: SUB2API_PUBLIC_MODEL,
      match_type: 'exact',
      target_platform: 'zhipu',
      upstream_model: 'glm-5.3-flash',
      endpoint: 'chat_completions',
      priority: 100,
      enabled: true,
      notes: 'ephemeral Electron E2E route',
    }),
  })
}

/** Connect an empty temporary workspace so the first Session composer unlocks. */
export async function connectTemporaryWorkspace(): Promise<void> {
  const workspace = join(requiredEnv('DSH_SUB2API_E2E_RUN_ROOT'), 'workspace')
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await browser.execute(async (path: string) => {
    const call = async (method: string, payload: unknown): Promise<unknown> => {
      const response = await fetch(`${location.origin}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method,
          payload,
        }),
      })
      const body = await response.json() as {
        result?: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }
      }
      if (!response.ok || body.result === undefined || !body.result.ok) {
        throw new Error(`${method} failed: ${JSON.stringify(body)}`)
      }
      return body.result.value
    }
    const value = await call('workspace.create', { path }) as { workspace?: { workspaceId?: string } }
    const workspaceId = value.workspace?.workspaceId
    if (typeof workspaceId !== 'string') throw new Error(`workspace.create omitted workspaceId: ${JSON.stringify(value)}`)
    const session = await call('session.create', { workspaceId }) as { sessionId?: string }
    if (typeof session.sessionId !== 'string') throw new Error(`session.create omitted sessionId: ${JSON.stringify(session)}`)
  }, workspace)
  await browser.refresh()
  await browser.$('textarea:enabled').waitForDisplayed({ timeout: 30_000 })
}

/** Select the Sub2API model in the composer and wait for one real reply. */
export async function selectModelAndSend(
  model: string,
  prompt: string,
  expected: string,
  sessionUrl: string,
): Promise<void> {
  await switchToSessionSurface(sessionUrl)
  const triggerSelector = 'button[aria-label^="选择模型"], button[aria-label^="Select model"]'
  const trigger = browser.$(triggerSelector)
  await trigger.waitForClickable({ timeout: 30_000 })
  await trigger.click()
  const modelPane = browser.$('div[role="menu"] button[role="menuitem"]')
  await modelPane.waitForClickable({ timeout: 30_000 })
  await modelPane.click()
  const choice = browser.$(`button[title="${model}"]`)
  await choice.waitForClickable({ timeout: 30_000 })
  await choice.click()
  await browser.waitUntil(async () => (await browser.$(triggerSelector).getAttribute('title'))?.includes(model) === true, {
    timeout: 30_000,
    timeoutMsg: `Desktop did not select ${model}`,
  })
  const input = browser.$('textarea')
  await input.waitForClickable({ timeout: 30_000 })
  await input.setValue(prompt)
  const send = browser.$('button[aria-label="发送消息"], button[aria-label="Send message"]')
  await send.waitForClickable({ timeout: 30_000 })
  await send.click()
  await browser.waitUntil(async () => {
    return await browser.execute((token: string) =>
      [...document.querySelectorAll<HTMLElement>('[data-annotation-source]')]
        .some(element => element.innerText.trim() === token), expected)
  }, { timeout: 180_000, interval: 1_000, timeoutMsg: 'Sub2API model reply did not reach the conversation' })
}

/** Record every process with a durable PID so the launcher can prove teardown. */
export async function recordOwnedProcesses(required = true): Promise<void> {
  let electronPid: number | undefined
  try {
    electronPid = await browser.electron.execute(() => process.pid)
  } catch (error) {
    if (required) throw error
    // A failed Electron session can still leave Host or PostgreSQL identities.
  }
  const smoke = await readFile(requiredEnv('DSH_DESKTOP_SMOKE_FILE'), 'utf8')
  const hostPids = [...smoke.matchAll(/ pid (\d+)$/gmu)].map(match => Number(match[1]))
  let postgresPid: number | undefined
  try {
    postgresPid = Number((await readFile(
      join(requiredEnv('DSH_HOME'), 'sub2api', 'data', 'pg', 'postmaster.pid'),
      'utf8',
    )).split('\n', 1)[0])
  } catch (error) {
    if (required) throw error
    // A failure before sidecar startup has no PostgreSQL identity to record.
  }
  const runRoot = requiredEnv('DSH_SUB2API_E2E_RUN_ROOT')
  const candidates = [electronPid, hostPids.at(-1), postgresPid].filter((pid): pid is number => pid !== undefined)
  const identities = await Promise.all(candidates.map(async (pid) => {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='])
      const signature = stdout.trim()
      if (signature === '') return undefined
      const owned = signature.includes(runRoot)
        || (electronPid !== undefined && pid !== electronPid && await isDescendantProcess(pid, electronPid))
      return owned ? { pid, signature } : undefined
    } catch (error) {
      if (required && (pid === electronPid || pid === hostPids.at(-1) || pid === postgresPid)) throw error
      return undefined
    }
  }))
  const artifact = join(requiredEnv('DSH_SUB2API_E2E_ARTIFACT_DIR'), 'owned-processes.json')
  let previous: Array<{ pid: number; signature: string }> = []
  try {
    const parsed = JSON.parse(await readFile(artifact, 'utf8')) as { processes?: Array<{ pid: number; signature: string }> }
    previous = parsed.processes ?? []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const processes = [...new Map([...previous, ...identities.filter(identity => identity !== undefined)]
    .map(identity => [`${String(identity.pid)}\0${identity.signature}`, identity])).values()]
  if (required && (electronPid === undefined || hostPids.length === 0 || postgresPid === undefined || processes.length < 3)) {
    throw new Error('Sub2API Electron e2e could not record every required process identity')
  }
  await writeFile(
    artifact,
    JSON.stringify({ processes }, undefined, 2) + '\n',
  )
}

async function isDescendantProcess(pid: number, ownerPid: number): Promise<boolean> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='])
  const parents = new Map(stdout.trim().split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line)
    return match === null ? [] : [[Number(match[1]), Number(match[2])] as const]
  }))
  const seen = new Set<number>()
  let current = pid
  while (!seen.has(current)) {
    seen.add(current)
    const parent = parents.get(current)
    if (parent === undefined || parent === 0) return false
    if (parent === ownerPid) return true
    current = parent
  }
  return false
}

async function adminJson<T = unknown>(origin: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(`${ADMIN_PREFIX}${path}`, origin), init)
  const envelope = await response.json() as { code?: number; message?: string; data?: T }
  if (!response.ok || (envelope.code !== undefined && envelope.code !== 0)) {
    throw new Error(`Sub2API admin request failed: HTTP ${String(response.status)} ${envelope.message ?? ''}`.trim())
  }
  return envelope.data as T
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
