import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(join(process.cwd(), '.github/workflows/desktop-release.yml'), 'utf8')
const parsed = load(workflow)
const desktopPackage = JSON.parse(
  readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8'),
) as unknown

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected record')
  return value
}

function job(name: string): Record<string, unknown> {
  return record(record(record(parsed).jobs)[name])
}

function steps(name: string): Record<string, unknown>[] {
  const value = job(name).steps
  if (!Array.isArray(value)) throw new Error(`expected ${name} steps`)
  return value.map(record)
}

describe('Desktop release workflow', () => {
  it('plans an explicit Desktop Bundle version before packaging', () => {
    expect(workflow).toContain('version:')
    expect(workflow).toContain('node apps/desktop/scripts/prepare-release.mjs')
    expect(workflow.match(/needs: prepare/g)).toHaveLength(2)
  })

  it('keeps release credentials out of preparation and dry-run packaging', () => {
    expect(JSON.stringify(job('prepare'))).not.toContain('secrets.')
    const mac = job('pack-mac')
    expect(record(mac.environment).name).toBe(
      "${{ inputs.publish && 'desktop-release' || 'desktop-dry-run' }}",
    )
    const dry = steps('pack-mac').find(step => step.name === 'Package unsigned')
    expect(JSON.stringify(dry)).not.toContain('secrets.')
    expect(dry?.run).toContain('-c.mac.identity=null')
    expect(dry?.run).toContain('-c.mac.notarize=false')
  })

  it('installs each macOS bundle on a matching runner architecture', () => {
    expect(workflow).toContain('arch: arm64\n            runner: macos-15')
    expect(workflow).toContain('arch: x64\n            runner: macos-15-intel')
    expect(workflow).toContain('runs-on: ${{ matrix.runner }}')
    expect(record(record(record(desktopPackage).build).mac).target).toEqual(['zip', 'dmg'])
  })

  it('builds the Electron entry and publishes an explicit asset list', () => {
    expect(workflow.match(/@deepseek-ai\/dsh-desktop build:main/g)).toHaveLength(2)
    expect(workflow.match(/--config\.node-linker=hoisted/g)).toHaveLength(2)
    expect(workflow.match(/--config\.inject-workspace-packages=true/g)).toHaveLength(2)
    expect(workflow.match(/--filter @deepseek-ai\/dsh deploy --prod/g)).toHaveLength(2)
    expect(workflow).not.toContain('--legacy')
    expect(workflow).toContain('RELEASE_VERSION: ${{ needs.prepare.outputs.version }}')
    expect(workflow).toContain('node apps/desktop/scripts/release-assets.mjs dist "$RELEASE_VERSION"')
    expect(workflow).not.toContain('dist/**/*')
  })

  it('projects the deployment Platform identity into every packaged artifact', () => {
    expect(workflow.match(/Project operated Platform identity/g)).toHaveLength(2)
    expect(workflow.match(/write-operated-platform-config\.mjs/g)).toHaveLength(2)
    expect(workflow.match(/DSH_DESKTOP_OPERATED_PLATFORM_CONFIG/g)).toHaveLength(4)
    expect(workflow.match(/vars\.PLATFORM_ORIGIN/g)).toHaveLength(2)
    expect(workflow.match(/vars\.PLATFORM_GITHUB_CALLBACK/g)).toHaveLength(2)
    expect(workflow.match(/vars\.PLATFORM_GITHUB_CLIENT_ID/g)).toHaveLength(2)
    expect(workflow).not.toContain('PLATFORM_GITHUB_CLIENT_SECRET')
    expect(record(record(desktopPackage).build).files).toContain('out/operated-platform.json')
  })

  it('keeps the prepared workspace dependencies intact while packaging', () => {
    expect(record(record(desktopPackage).build).npmRebuild).toBe(false)
    expect(workflow).not.toContain('dsh-desktop exec electron-builder')
    expect(workflow.match(/node_modules\/\.bin\/electron-builder/g)).toHaveLength(3)
    const packageSteps = [...steps('pack-mac'), ...steps('pack-win')].filter(step =>
      String(step.name).startsWith('Package'),
    )
    expect(packageSteps).toHaveLength(3)
    expect(packageSteps.every(step => step['working-directory'] === 'apps/desktop')).toBe(true)
    const winPackage = steps('pack-win').find(step => step.name === 'Package')
    expect(winPackage?.run).toContain("if ('${{ inputs.publish }}' -eq 'true')")
    expect(winPackage?.run).toContain("$compression = 'normal'")
    expect(winPackage?.run).toContain("$compression = 'store'")
    expect(winPackage?.run).toContain('"-c.compression=$compression"')
  })

  it('runs the declared Electron runtime e2e after install on both pack jobs', () => {
    const mac = steps('pack-mac')
    const win = steps('pack-win')
    const macE2e = mac.findIndex(step => step.name === 'Electron cookie-isolation e2e')
    const winE2e = win.findIndex(step => step.name === 'Electron cookie-isolation e2e')
    const macInstall = mac.findIndex(step => step.name === 'Install (immutable)')
    const winInstall = win.findIndex(step => step.name === 'Install (immutable)')
    const macBuild = mac.findIndex(step => step.name === 'Build')
    const winBuild = win.findIndex(step => step.name === 'Build')
    expect(mac[macE2e]?.run).toBe('pnpm run test:electron-runtime-e2e')
    expect(win[winE2e]?.run).toBe('pnpm run test:electron-runtime-e2e')
    expect(macInstall).toBeLessThan(macE2e)
    expect(macE2e).toBeLessThan(macBuild)
    expect(winInstall).toBeLessThan(winE2e)
    expect(winE2e).toBeLessThan(winBuild)
  })

  it('smokes every packaged app before artifact upload', () => {
    expect(workflow.match(/electron-smoke-packaged\.spec\.ts/g)).toHaveLength(2)
    expect(workflow.match(/DSH_PACKAGED_APP_BIN/g)).toHaveLength(2)
    expect(workflow).not.toContain('pnpm exec vitest run apps/desktop/tests/electron-smoke-packaged.spec.ts')
    const packagedSmoke = readFileSync(
      join(process.cwd(), 'apps/desktop/tests/electron-smoke-packaged.spec.ts'),
      'utf8',
    )
    expect(packagedSmoke).toContain("child.stdout?.on('data'")
    expect(packagedSmoke).toContain("child.stderr?.on('data'")
    expect(packagedSmoke).toContain('ELECTRON_ENABLE_LOGGING')
    expect(packagedSmoke).toContain('exited ${String(exitCode)} before ok')
    expect(workflow.match(/node_modules\/\.bin\/vitest/g)).toHaveLength(2)
    const macSmoke = workflow.indexOf('app_bin=$(find apps/desktop/release')
    const winSmoke = workflow.indexOf('$appBin = Get-ChildItem apps/desktop/release')
    expect(macSmoke).toBeGreaterThan(workflow.indexOf('electron-builder --mac'))
    expect(macSmoke).toBeLessThan(workflow.indexOf('name: gestalt-mac-'))
    expect(winSmoke).toBeGreaterThan(workflow.indexOf('electron-builder --win'))
    expect(winSmoke).toBeLessThan(workflow.indexOf('name: gestalt-win-x64'))
  })

  it('verifies the Windows executable icon before smoke and artifact upload', () => {
    const winSteps = steps('pack-win')
    const packageStep = winSteps.findIndex(step => step.name === 'Package')
    const verifyIcon = winSteps.findIndex(step => step.name === 'Verify packaged icon')
    const smoke = winSteps.findIndex(step => step.name === 'Smoke packaged Desktop Host')
    const upload = winSteps.findIndex(step => step.uses === 'actions/upload-artifact@v4')

    expect(winSteps[verifyIcon]?.run).toContain('verify-windows-icon.mjs')
    expect(winSteps[verifyIcon]?.run).toContain('win-unpacked')
    expect(packageStep).toBeLessThan(verifyIcon)
    expect(verifyIcon).toBeLessThan(smoke)
    expect(verifyIcon).toBeLessThan(upload)
  })

  it('forces and verifies signing and notarization before signed artifacts upload', () => {
    const macSteps = steps('pack-mac')
    const signed = macSteps.findIndex(step => step.name === 'Package signed and notarized')
    const verify = macSteps.findIndex(step => step.name === 'Verify signed app')
    const upload = macSteps.findIndex(step => step.uses === 'actions/upload-artifact@v4')
    expect(JSON.stringify(macSteps[signed])).toContain('secrets.CSC_LINK')
    expect(macSteps[signed]?.run).toContain('-c.forceCodeSigning=true')
    expect(macSteps[verify]?.run).toContain('codesign --verify --deep --strict')
    expect(macSteps[verify]?.run).toContain('xcrun stapler validate')
    expect(signed).toBeLessThan(verify)
    expect(verify).toBeLessThan(upload)
  })

  it('raises the open-file limit to the runner hard limit before macOS signing starts', () => {
    const signed = steps('pack-mac').find(step => step.name === 'Package signed and notarized')
    const command = String(signed?.run)
    expect(command).toContain('hard_open_files=$(ulimit -Hn)')
    expect(command).toContain('ulimit -n "$hard_open_files"')
    expect(command.indexOf('ulimit -n "$hard_open_files"')).toBeLessThan(
      command.indexOf('electron-builder --mac'),
    )
  })

  it('publishes a verified draft only after every packaged smoke passes', () => {
    expect(workflow).toContain('needs: [prepare, pack-mac, pack-win]')
    expect(workflow).toContain('tag=${{ needs.prepare.outputs.tag }}')
    expect(workflow).toContain('gh release create "$tag"')
    expect(workflow).toContain('gh api --method POST "repos/$GITHUB_REPOSITORY/git/refs"')
    expect(workflow).toContain('--target "$GITHUB_SHA"')
    expect(workflow).toContain('--verify-tag')
    expect(workflow).toContain('--draft')
    expect(workflow).toContain('gh release upload "$tag"')
    expect(workflow).toContain('gh release edit "$tag" --draft=false --latest')
    expect(workflow).toContain('if [[ "$tag_owned" == \'true\' ]]')
    expect(workflow).toContain('trap cleanup EXIT')
    expect(workflow).toContain("trap 'exit 130' INT")
    expect(workflow).toContain("trap 'exit 143' TERM")
    expect(workflow).toContain('published=true')
    expect(workflow).toContain('trap - EXIT INT TERM')
    expect(workflow).not.toContain('trap cleanup ERR')
    expect(workflow).not.toContain('--cleanup-tag')
    expect(workflow).not.toContain('tag=${GITHUB_REF_NAME}')

    const createTag = workflow.indexOf('gh api --method POST "repos/$GITHUB_REPOSITORY/git/refs"')
    const createDraft = workflow.indexOf('gh release create "$tag"')
    const uploadAssets = workflow.indexOf('gh release upload "$tag"')
    const publishRelease = workflow.indexOf('gh release edit "$tag" --draft=false --latest')
    const markPublished = workflow.indexOf('published=true')
    expect(createTag).toBeLessThan(createDraft)
    expect(createDraft).toBeLessThan(uploadAssets)
    expect(uploadAssets).toBeLessThan(publishRelease)
    expect(publishRelease).toBeLessThan(markPublished)
  })

  it('renders verified release notes before tag creation and passes the file to the draft', () => {
    const publishSteps = steps('publish')
    const renderIndex = publishSteps.findIndex(step => step.name === 'Render release notes')
    const publishIndex = publishSteps.findIndex(step => step.name === 'Publish release')
    const render = String(publishSteps[renderIndex]?.run)
    const publish = String(publishSteps[publishIndex]?.run)

    expect(render).toContain('apps/desktop/scripts/render-release-notes.mjs')
    expect(render).toContain('"$RELEASE_VERSION" "$GITHUB_SHA" "$RELEASE_NOTES_FILE"')
    expect(publish).toContain('--notes-file "$RELEASE_NOTES_FILE"')
    expect(workflow).not.toContain('--generate-notes')
    expect(renderIndex).toBeGreaterThan(-1)
    expect(renderIndex).toBeLessThan(publishIndex)
  })
})
